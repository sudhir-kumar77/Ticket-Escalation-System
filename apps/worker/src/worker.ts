import pino from 'pino'
import { loadConfig } from '@nvara/config'
import { createDbPool } from '@nvara/db'
import type pg from 'pg'
import { createTransport, type Transporter, type SendMailOptions } from 'nodemailer'

export type SlaEvaluation = {
  candidates: number
  inspected: number
  breached: number
  skipped: number
  failures: number
  oldestOverdueAt?: string
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
  for (const candidate of candidates.rows) {
    result.inspected += 1
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const locked = await client.query<any>(
        `SELECT s.id,s.assignment_id,a.request_id,s.status,s.acknowledged_at,a.assignee_user_id,r.organization_id
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
  let stopping = false
  let currentPollPromise: Promise<SlaEvaluation> | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined
  let emailQueueTimer: ReturnType<typeof setTimeout> | undefined
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

  logger.info({ intervalSeconds: config.SLA_POLL_INTERVAL_SECONDS, batchSize: 100, cleanupIntervalHours: CLEANUP_INTERVAL_MS / 3_600_000, emailQueueIntervalSeconds: EMAIL_QUEUE_INTERVAL_MS / 1000 }, 'worker started')
  void poll()
  void scheduleCleanup()
  void scheduleEmailQueue()

  async function shutdown(signal: string) {
    if (stopping) return
    stopping = true
    if (timer) clearTimeout(timer)
    if (cleanupTimer) clearTimeout(cleanupTimer)
    if (emailQueueTimer) clearTimeout(emailQueueTimer)
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
