import pino from 'pino'
import { loadConfig, type AppConfig } from '@nvara/config'
import { createDbPool } from '@nvara/db'
import type pg from 'pg'
import { createTransport, type Transporter, type SendMailOptions } from 'nodemailer'
import { createSign, createHash } from 'node:crypto'

export type SlaEvaluation = {
  candidates: number
  inspected: number
  breached: number
  skipped: number
  failures: number
  oldestOverdueAt?: string
}

function hashToken(token: string): string {
  return createHash('sha256').update(token.trim()).digest('hex')
}

function tokenFingerprint(token: string): string {
  return hashToken(token).slice(0, 12)
}

let cachedAccessToken: { token: string; expiresAt: number } | null = null

async function getGoogleAccessToken(config: AppConfig, logger: pino.Logger): Promise<string | null> {
  const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = config
  if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
    return null
  }

  const now = Math.floor(Date.now() / 1000)
  if (cachedAccessToken && cachedAccessToken.expiresAt > now + 60) {
    return cachedAccessToken.token
  }

  const privateKey = FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const claimSet = Buffer.from(
    JSON.stringify({
      iss: FIREBASE_CLIENT_EMAIL,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    })
  ).toString('base64url')

  const sign = createSign('RSA-SHA256')
  sign.update(`${header}.${claimSet}`)
  const signature = sign.sign(privateKey, 'base64url')
  const assertion = `${header}.${claimSet}.${signature}`

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  })

  if (!tokenRes.ok) {
    const errText = await tokenRes.text()
    logger.error({ status: tokenRes.status, err: errText }, 'Worker: Failed to obtain Google OAuth2 access token for FCM')
    return null
  }

  const tokenData = (await tokenRes.json()) as { access_token: string; expires_in: number }
  cachedAccessToken = {
    token: tokenData.access_token,
    expiresAt: now + (tokenData.expires_in || 3600),
  }
  return cachedAccessToken.token
}

async function sendWorkerFcmPush(
  token: string,
  title: string,
  body: string,
  data: Record<string, string>,
  config: AppConfig,
  logger: pino.Logger
): Promise<{ success: boolean; status: 'SENT' | 'FAILED' | 'REVOKED' | 'SKIPPED'; errorCode?: string; errorMessage?: string }> {
  if (!config.FIREBASE_PROJECT_ID || !config.FIREBASE_CLIENT_EMAIL || !config.FIREBASE_PRIVATE_KEY) {
    return { success: true, status: 'SKIPPED' }
  }

  const fingerprint = tokenFingerprint(token)
  try {
    const accessToken = await getGoogleAccessToken(config, logger)
    if (!accessToken) {
      return { success: false, status: 'FAILED', errorCode: 'AUTH_FAILED', errorMessage: 'Could not obtain FCM access token' }
    }

    const fcmUrl = `https://fcm.googleapis.com/v1/projects/${config.FIREBASE_PROJECT_ID}/messages:send`
    const response = await fetch(fcmUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          token,
          notification: { title, body },
          data,
          webpush: {
            notification: {
              title,
              body,
              icon: '/favicon.ico',
              data,
            },
          },
        },
      }),
    })

    if (response.ok) {
      return { success: true, status: 'SENT' }
    }

    const status = response.status
    const errBody = await response.json().catch(() => ({}))
    const fcmError = (errBody as any)?.error?.details?.[0]?.errorCode || (errBody as any)?.error?.status || String(status)
    const fcmMessageText = (errBody as any)?.error?.message || response.statusText

    const isUnregistered =
      status === 404 ||
      status === 410 ||
      fcmError === 'UNREGISTERED' ||
      fcmError === 'INVALID_ARGUMENT' ||
      fcmMessageText.includes('registration-token-not-registered') ||
      fcmMessageText.includes('Requested entity was not found')

    if (isUnregistered) {
      return { success: false, status: 'REVOKED', errorCode: fcmError, errorMessage: fcmMessageText }
    }

    return { success: false, status: 'FAILED', errorCode: fcmError, errorMessage: fcmMessageText }
  } catch (err) {
    return { success: false, status: 'FAILED', errorCode: 'NETWORK_ERROR', errorMessage: String(err) }
  }
}

export async function evaluateOverdueSlas(pool: pg.Pool, logger = pino({ level: 'silent' })): Promise<SlaEvaluation> {
  const candidates = await pool.query<{ id: string; deadline_at: string }>(
    `SELECT s.id,s.deadline_at FROM sla_records s JOIN assignments a ON a.id=s.assignment_id JOIN requests r ON r.id=a.request_id
     WHERE s.status='active' AND s.acknowledged_at IS NULL AND a.ended_at IS NULL AND r.deleted_at IS NULL AND s.deadline_at<=CURRENT_TIMESTAMP
     ORDER BY s.deadline_at LIMIT 100`,
  )
  const result: SlaEvaluation = {
    candidates: candidates.rowCount ?? candidates.rows.length,
    inspected: 0,
    breached: 0,
    skipped: 0,
    failures: 0,
    oldestOverdueAt: candidates.rows[0]?.deadline_at,
  }
  const pmCache = new Map<string, { id: string }[]>()

  for (const candidate of candidates.rows) {
    result.inspected += 1
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const locked = await client.query<any>(
        `SELECT s.id,s.assignment_id,a.request_id,s.status,s.acknowledged_at,a.assignee_user_id,r.organization_id,r.public_reference
         FROM sla_records s JOIN assignments a ON a.id=s.assignment_id JOIN requests r ON r.id=a.request_id
         WHERE s.id=$1 AND a.ended_at IS NULL AND r.deleted_at IS NULL AND s.deadline_at<=CURRENT_TIMESTAMP
         FOR UPDATE OF r,a,s`, [candidate.id],
      )
      if (!locked.rowCount || locked.rows[0].status !== 'active' || locked.rows[0].acknowledged_at) {
        result.skipped += 1
        await client.query('ROLLBACK')
        continue
      }
      const row = locked.rows[0]
      const idempotencyKey = `sla:${row.id}:acknowledgement-breach`
      const existing = await client.query('SELECT 1 FROM escalation_events WHERE idempotency_key=$1', [idempotencyKey])
      if (existing.rowCount) {
        result.skipped += 1
        await client.query('ROLLBACK')
        continue
      }
      await client.query("UPDATE sla_records SET breached_at=CURRENT_TIMESTAMP,status='breached',updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND status='active'", [row.id])
      await client.query('INSERT INTO escalation_events(request_id,assignment_id,sla_record_id,responsible_user_id,reason,policy_code,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7)', [row.request_id, row.assignment_id, row.id, row.assignee_user_id, 'acknowledgement_sla_breached', 'acknowledgement_24h', idempotencyKey])
      for (const event of ['sla_breached', 'escalation_triggered']) {
        await client.query("INSERT INTO audit_events(organization_id,request_id,assignment_id,sla_record_id,actor_type,event_type,new_state,metadata) VALUES($1,$2,$3,$4,'system',$5,'breached',$6)", [row.organization_id, row.request_id, row.assignment_id, row.id, event, JSON.stringify({ reason: 'acknowledgement_sla_breached' })])
      }

      // Outbox notifications for SLA Breach & Escalation (Cached by org per cycle)
      const publicRef = row.public_reference || row.request_id
      let pms = pmCache.get(row.organization_id)
      if (!pms) {
        const pmRes = await client.query<{ id: string }>(
          `SELECT u.id FROM users u
           JOIN user_roles ur ON ur.user_id = u.id
           JOIN roles r ON r.id = ur.role_id
           WHERE u.organization_id = $1 AND r.code = 'project_manager' AND u.is_active = true`,
          [row.organization_id]
        )
        pms = pmRes.rows
        pmCache.set(row.organization_id, pms)
      }

      if (row.assignee_user_id) {
        await client.query(
          `INSERT INTO notification_events (organization_id, recipient_user_id, type, title, body, request_id, assignment_id, business_event_id, dispatch_status)
           VALUES ($1, $2, 'SLA_BREACHED', 'SLA Breached', $3, $4, $5, $6, 'QUEUED')
           ON CONFLICT (organization_id, recipient_user_id, type, business_event_id) WHERE business_event_id IS NOT NULL DO NOTHING`,
          [row.organization_id, row.assignee_user_id, `SLA breached for request ${publicRef}`, row.request_id, row.assignment_id, `sla_breach:${row.id}:${row.assignee_user_id}`]
        )
      }

      for (const pm of pms) {
        await client.query(
          `INSERT INTO notification_events (organization_id, recipient_user_id, type, title, body, request_id, assignment_id, business_event_id, dispatch_status)
           VALUES ($1, $2, 'SLA_BREACHED', 'SLA Breached', $3, $4, $5, $6, 'QUEUED')
           ON CONFLICT (organization_id, recipient_user_id, type, business_event_id) WHERE business_event_id IS NOT NULL DO NOTHING`,
          [row.organization_id, pm.id, `SLA breached for request ${publicRef}`, row.request_id, row.assignment_id, `sla_breach:${row.id}:${pm.id}`]
        )
        await client.query(
          `INSERT INTO notification_events (organization_id, recipient_user_id, type, title, body, request_id, assignment_id, business_event_id, dispatch_status)
           VALUES ($1, $2, 'ESCALATION_TRIGGERED', 'Escalation Triggered', $3, $4, $5, $6, 'QUEUED')
           ON CONFLICT (organization_id, recipient_user_id, type, business_event_id) WHERE business_event_id IS NOT NULL DO NOTHING`,
          [row.organization_id, pm.id, `Automated escalation triggered for request ${publicRef}`, row.request_id, row.assignment_id, `escalation:${row.id}:${pm.id}`]
        )
      }

      await client.query('UPDATE requests SET version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$1', [row.request_id])
      await client.query('COMMIT')
      result.breached += 1
    } catch (error) {
      result.failures += 1
      await client.query('ROLLBACK').catch(() => undefined)
      logger.error({ err: error, slaRecordId: candidate.id }, 'SLA breach transaction failed')
    } finally {
      client.release()
    }
  }
  return result
}

async function cleanupIdempotencyKeys(pool: pg.Pool, logger: pino.Logger): Promise<number> {
  const result = await pool.query('DELETE FROM idempotency_keys WHERE expires_at < now()')
  const deletedCount = result.rowCount ?? 0
  if (deletedCount > 0) {
    logger.info({ deletedCount }, 'idempotency keys cleanup completed')
  }
  return deletedCount
}

export async function processNotificationQueue(pool: pg.Pool, logger: pino.Logger, config: AppConfig): Promise<number> {
  const BATCH_SIZE = 25
  let processedCount = 0

  // Recover stale SENDING locks older than 2 minutes
  await pool.query(
    `UPDATE notification_events
     SET dispatch_status = 'QUEUED', locked_at = NULL
     WHERE dispatch_status = 'SENDING' AND locked_at < now() - interval '2 minutes'`
  )

  while (true) {
    const client = await pool.connect()
    let batch: any[] = []
    try {
      await client.query('BEGIN')
      const locked = await client.query<{
        id: string
        organization_id: string
        recipient_user_id: string
        type: string
        title: string
        body: string
        request_id: string | null
        attempts: number
        max_attempts: number
      }>(
        `SELECT id, organization_id, recipient_user_id, type, title, body, request_id, attempts, max_attempts
         FROM notification_events
         WHERE dispatch_status = 'QUEUED'
         ORDER BY created_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [BATCH_SIZE]
      )

      batch = locked.rows
      if (batch.length === 0) {
        await client.query('COMMIT')
        break
      }

      const ids = batch.map((r) => r.id)
      await client.query(
        `UPDATE notification_events
         SET dispatch_status = 'SENDING', locked_at = now(), attempts = attempts + 1
         WHERE id = ANY($1::uuid[])`,
        [ids]
      )
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined)
      logger.error({ err }, 'Worker: failed locking notification batch')
      break
    } finally {
      client.release()
    }

    // Batch fetch preferences and devices for all unique recipients in this batch (O(1) round trips)
    const uniqueUserIds = [...new Set(batch.map((r) => r.recipient_user_id))]

    const prefRows = await pool.query<{
      user_id: string
      browser_push_enabled: boolean
      sla_alerts: boolean
      assignment_alerts: boolean
      workflow_alerts: boolean
      team_alerts: boolean
      security_alerts: boolean
    }>(
      `SELECT user_id, browser_push_enabled, sla_alerts, assignment_alerts, workflow_alerts, team_alerts, security_alerts
       FROM user_notification_preferences
       WHERE user_id = ANY($1::uuid[])`,
      [uniqueUserIds]
    )
    const prefsMap = new Map(prefRows.rows.map((p) => [p.user_id, p]))

    const deviceRows = await pool.query<{ id: string; user_id: string; fcm_token: string }>(
      `SELECT id, user_id, fcm_token
       FROM notification_devices
       WHERE user_id = ANY($1::uuid[]) AND revoked_at IS NULL`,
      [uniqueUserIds]
    )
    const devicesMap = new Map<string, { id: string; fcm_token: string }[]>()
    for (const dev of deviceRows.rows) {
      let list = devicesMap.get(dev.user_id)
      if (!list) {
        list = []
        devicesMap.set(dev.user_id, list)
      }
      list.push(dev)
    }

    const DEFAULT_PREFS = {
      browser_push_enabled: true,
      sla_alerts: true,
      assignment_alerts: true,
      workflow_alerts: true,
      team_alerts: true,
      security_alerts: true,
    }

    for (const item of batch) {
      processedCount++
      const prefs = prefsMap.get(item.recipient_user_id) ?? DEFAULT_PREFS

      let categoryAllowed = true
      if (item.type.startsWith('SLA_') || item.type === 'ESCALATION_TRIGGERED') categoryAllowed = prefs.sla_alerts
      else if (item.type.startsWith('REQUEST_ASSIGNED') || item.type.startsWith('REQUEST_REASSIGNED')) categoryAllowed = prefs.assignment_alerts
      else if (item.type.startsWith('REQUEST_') || item.type === 'COMMENT_ADDED') categoryAllowed = prefs.workflow_alerts
      else if (item.type.startsWith('TEAM_MEMBER_')) categoryAllowed = prefs.team_alerts
      else if (item.type.startsWith('ROLE_') || item.type.startsWith('PASSWORD_') || item.type.startsWith('REMOTE_')) categoryAllowed = prefs.security_alerts

      const shouldSendPush = prefs.browser_push_enabled && categoryAllowed

      if (!shouldSendPush) {
        await pool.query(
          `UPDATE notification_events
           SET dispatch_status = 'SKIPPED', dispatched_at = now(), locked_at = NULL
           WHERE id = $1`,
          [item.id]
        )
        continue
      }

      const userDevices = devicesMap.get(item.recipient_user_id) ?? []

      if (userDevices.length === 0) {
        await pool.query(
          `UPDATE notification_events
           SET dispatch_status = 'SKIPPED', dispatched_at = now(), locked_at = NULL
           WHERE id = $1`,
          [item.id]
        )
        continue
      }

      let pushSuccessCount = 0
      let pushFailedCount = 0
      let lastErr: string | null = null

      for (const device of userDevices) {
        const pushResult = await sendWorkerFcmPush(
          device.fcm_token,
          item.title,
          item.body,
          { notificationId: item.id, type: item.type, requestId: item.request_id || '' },
          config,
          logger
        )

        await pool.query(
          `INSERT INTO notification_delivery_attempts (notification_id, device_id, provider, status, error_code, error_message)
           VALUES ($1, $2, 'fcm', $3, $4, $5)`,
          [item.id, device.id, pushResult.status, pushResult.errorCode || null, pushResult.errorMessage || null]
        )

        if (pushResult.status === 'REVOKED') {
          await pool.query('UPDATE notification_devices SET revoked_at = now() WHERE id = $1', [device.id])
          logger.info({ deviceId: device.id }, 'Worker: revoked invalid FCM device token')
        }

        if (pushResult.success || pushResult.status === 'SKIPPED') {
          pushSuccessCount++
        } else {
          pushFailedCount++
          lastErr = pushResult.errorMessage || pushResult.errorCode || 'Push failed'
        }
      }

      if (pushSuccessCount > 0 || (userDevices.length > 0 && pushFailedCount === 0)) {
        await pool.query(
          `UPDATE notification_events
           SET dispatch_status = 'SENT', dispatched_at = now(), locked_at = NULL
           WHERE id = $1`,
          [item.id]
        )
      } else {
        const isFinal = item.attempts >= item.max_attempts
        await pool.query(
          `UPDATE notification_events
           SET dispatch_status = $1, last_error = $2, locked_at = NULL
           WHERE id = $3`,
          [isFinal ? 'FAILED' : 'QUEUED', lastErr, item.id]
        )
      }
    }

    if (batch.length < BATCH_SIZE) break
  }

  return processedCount
}

async function processEmailQueue(pool: pg.Pool, logger: pino.Logger, config: ReturnType<typeof loadConfig>): Promise<number> {
  const MAX_ATTEMPTS = 5
  const BATCH_SIZE = 10
  let sentCount = 0
  let queued: { rowCount: number | null; rows: any[] } | null = null

  // Check if SMTP is configured
  const hasSmtpConfig = config.EMAIL_HOST && config.EMAIL_USER && config.EMAIL_PASS
  if (!hasSmtpConfig) {
    // No SMTP configured - emails will remain queued
    return 0
  }

  const transporter = createTransport({
    host: config.EMAIL_HOST!,
    port: config.EMAIL_PORT ?? 587,
    secure: config.EMAIL_SECURE === true,
    auth: { user: config.EMAIL_USER!, pass: config.EMAIL_PASS! },
  })

  // Verify SMTP connection
  try {
    await transporter.verify()
  } catch (error) {
    logger.error({ err: error }, 'SMTP connection failed, skipping email queue processing')
    return 0
  }

  // Process queued emails
  while (true) {
    const client = await pool.connect()
    try {
      // Get a batch of queued emails
      queued = await client.query<{ id: string; to_email: string; subject: string; html: string; text: string; metadata: any; attempts: number }>(
        `SELECT id, to_email, subject, html, text, metadata, attempts
         FROM email_queue
         WHERE status = 'QUEUED' AND scheduled_at <= now()
         ORDER BY scheduled_at
         LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [BATCH_SIZE]
      )

      if (!queued?.rowCount) break

      for (const email of queued.rows) {
        let sent = false
        try {
          // Mark as sending
          await client.query(`UPDATE email_queue SET status = 'SENDING', attempts = attempts + 1 WHERE id = $1`, [email.id])

          const from = config.EMAIL_FROM ?? `Nvara Operations <noreply@${config.EMAIL_HOST!}>`
          await transporter.sendMail({
            from,
            to: email.to_email,
            subject: email.subject,
            text: email.text,
            html: email.html,
          })

          // Mark as sent
          await client.query(`UPDATE email_queue SET status = 'SENT', sent_at = now(), updated_at = now() WHERE id = $1`, [email.id])
          sent = true
          sentCount++
        } catch (error) {
          if (!sent) {
            const newAttempts = email.attempts + 1
            if (newAttempts >= 5) {
              await client.query(`UPDATE email_queue SET status = 'FAILED', last_error = $1, updated_at = now() WHERE id = $2`, [String(error), email.id])
            } else {
              // Schedule retry with exponential backoff
              const delayMinutes = Math.min(15 * Math.pow(2, newAttempts - 1), 240) // Max 4 hours
              await client.query(
                `UPDATE email_queue SET status = 'QUEUED', last_error = $1, scheduled_at = now() + interval '${delayMinutes} minutes', updated_at = now() WHERE id = $2`,
                [String(error), email.id]
              )
            }
          }
        }
      }
    } catch (error) {
      logger.error({ err: error }, 'Email queue processing failed')
    } finally {
      client.release()
    }

    // If we processed less than a full batch, we're caught up
    if ((queued?.rowCount ?? 0) < BATCH_SIZE) break
  }

  if (sentCount > 0) {
    logger.info({ sentCount }, 'email queue processing completed')
  }
  return sentCount
}

export function startWorker() {
  const config = loadConfig()
  const logger = pino({ level: config.LOG_LEVEL })
  const pool = createDbPool(config.DATABASE_URL)
  pool.on('error', (error) => logger.error({ err: error }, 'worker database pool error'))

  const SHUTDOWN_TIMEOUT_MS = 30_000
  const CLEANUP_INTERVAL_MS = 60 * 60 * 1000 // 1 hour
  const EMAIL_QUEUE_INTERVAL_MS = 30 * 1000 // 30 seconds
  const NOTIFICATION_QUEUE_INTERVAL_MS = 10 * 1000 // 10 seconds
  let stopping = false
  let currentPollPromise: Promise<SlaEvaluation> | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined
  let emailQueueTimer: ReturnType<typeof setTimeout> | undefined
  let notificationQueueTimer: ReturnType<typeof setTimeout> | undefined
  let retryCount = 0

  async function poll() {
    if (stopping) return
    const started = Date.now()
    currentPollPromise = evaluateOverdueSlas(pool, logger)
    try {
      const result = await currentPollPromise
      retryCount = 0
      logger.info({
        pollDurationMs: Date.now() - started,
        recordsInspected: result.inspected,
        breachesCreated: result.breached,
        recordsSkipped: result.skipped,
        dbFailures: result.failures,
        workerLagMs: result.oldestOverdueAt ? Math.max(0, Date.now() - new Date(result.oldestOverdueAt).getTime()) : 0,
      }, 'SLA poll completed')
    } catch (error) {
      retryCount += 1
      logger.error({ err: error, retryCount, pollDurationMs: Date.now() - started }, 'SLA poll failed; retrying')
    } finally {
      currentPollPromise = null
      if (!stopping) timer = setTimeout(() => void poll(), config.SLA_POLL_INTERVAL_SECONDS * 1000)
    }
  }

  async function scheduleCleanup() {
    if (stopping) return
    try {
      await cleanupIdempotencyKeys(pool, logger)
    } catch (error) {
      logger.error({ err: error }, 'idempotency keys cleanup failed')
    }
    if (!stopping) cleanupTimer = setTimeout(scheduleCleanup, CLEANUP_INTERVAL_MS)
  }

  async function scheduleEmailQueue() {
    if (stopping) return
    try {
      await processEmailQueue(pool, logger, config)
    } catch (error) {
      logger.error({ err: error }, 'email queue processing failed')
    }
    if (!stopping) emailQueueTimer = setTimeout(scheduleEmailQueue, EMAIL_QUEUE_INTERVAL_MS)
  }

  async function scheduleNotificationQueue() {
    if (stopping) return
    try {
      await processNotificationQueue(pool, logger, config)
    } catch (error) {
      logger.error({ err: error }, 'notification queue processing failed')
    }
    if (!stopping) notificationQueueTimer = setTimeout(scheduleNotificationQueue, NOTIFICATION_QUEUE_INTERVAL_MS)
  }

  logger.info({
    intervalSeconds: config.SLA_POLL_INTERVAL_SECONDS,
    batchSize: 100,
    cleanupIntervalHours: CLEANUP_INTERVAL_MS / 3_600_000,
    emailQueueIntervalSeconds: EMAIL_QUEUE_INTERVAL_MS / 1000,
    notificationQueueIntervalSeconds: NOTIFICATION_QUEUE_INTERVAL_MS / 1000,
  }, 'worker started')

  void poll()
  void scheduleCleanup()
  void scheduleEmailQueue()
  void scheduleNotificationQueue()

  async function shutdown(signal: string) {
    if (stopping) return
    stopping = true
    if (timer) clearTimeout(timer)
    if (cleanupTimer) clearTimeout(cleanupTimer)
    if (emailQueueTimer) clearTimeout(emailQueueTimer)
    if (notificationQueueTimer) clearTimeout(notificationQueueTimer)
    logger.info({ signal }, 'worker shutting down')

    if (currentPollPromise) {
      logger.info('draining in-flight poll...')
      try {
        await Promise.race([
          currentPollPromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error('shutdown timeout')), SHUTDOWN_TIMEOUT_MS)),
        ])
        logger.info('in-flight poll completed')
      } catch (error) {
        logger.warn({ err: error }, 'shutdown timeout or error while draining poll')
      }
    }

    await pool.end()
    process.exit(0)
  }
  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
}
