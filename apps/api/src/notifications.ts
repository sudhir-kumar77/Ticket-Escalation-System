import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { AppConfig } from '@nvara/config';
import { ApiError } from './errors.js';
import { authenticatePm } from './auth.js';
import { hashToken, sendFcmPushNotification, tokenFingerprint } from './fcmClient.js';
import { logger } from './logger.js';

export type NotificationType =
  | 'REQUEST_ASSIGNED'
  | 'REQUEST_REASSIGNED'
  | 'REQUEST_ACKNOWLEDGED'
  | 'REQUEST_STARTED'
  | 'REQUEST_RESOLVED'
  | 'SLA_WARNING'
  | 'SLA_BREACHED'
  | 'ESCALATION_TRIGGERED'
  | 'COMMENT_ADDED'
  | 'TEAM_MEMBER_INVITED'
  | 'TEAM_MEMBER_ONBOARDED'
  | 'TEAM_MEMBER_DEACTIVATED'
  | 'TEAM_MEMBER_REACTIVATED'
  | 'ROLE_CHANGED'
  | 'PASSWORD_CHANGED'
  | 'REMOTE_SESSIONS_REVOKED';

export type NotificationCategory = 'sla' | 'assignment' | 'workflow' | 'team' | 'security';

export function getNotificationCategory(type: NotificationType): NotificationCategory {
  switch (type) {
    case 'SLA_WARNING':
    case 'SLA_BREACHED':
    case 'ESCALATION_TRIGGERED':
      return 'sla';
    case 'REQUEST_ASSIGNED':
    case 'REQUEST_REASSIGNED':
      return 'assignment';
    case 'REQUEST_ACKNOWLEDGED':
    case 'REQUEST_STARTED':
    case 'REQUEST_RESOLVED':
    case 'COMMENT_ADDED':
      return 'workflow';
    case 'TEAM_MEMBER_INVITED':
    case 'TEAM_MEMBER_ONBOARDED':
    case 'TEAM_MEMBER_DEACTIVATED':
    case 'TEAM_MEMBER_REACTIVATED':
      return 'team';
    case 'ROLE_CHANGED':
    case 'PASSWORD_CHANGED':
    case 'REMOTE_SESSIONS_REVOKED':
      return 'security';
  }
}

export type QueueNotificationParams = {
  organizationId: string;
  recipientUserId: string;
  type: NotificationType;
  title: string;
  body: string;
  requestId?: string | null;
  assignmentId?: string | null;
  auditEventId?: string | null;
  metadata?: Record<string, any>;
  businessEventId?: string | null;
};

/**
 * Atomically inserts a notification event into the PostgreSQL outbox.
 * MUST be executed within the active business mutation transaction.
 * Deduplicates automatically via business_event_id unique constraint.
 */
export async function queueNotification(
  client: pg.PoolClient,
  params: QueueNotificationParams
): Promise<string | null> {
  const {
    organizationId,
    recipientUserId,
    type,
    title,
    body,
    requestId = null,
    assignmentId = null,
    auditEventId = null,
    metadata = {},
    businessEventId = null,
  } = params;

  const result = await client.query<{ id: string }>(
    `INSERT INTO notification_events (
      organization_id, recipient_user_id, type, title, body,
      request_id, assignment_id, audit_event_id, metadata, business_event_id, dispatch_status
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'QUEUED')
    ON CONFLICT (organization_id, recipient_user_id, type, business_event_id)
    WHERE business_event_id IS NOT NULL
    DO NOTHING
    RETURNING id`,
    [
      organizationId,
      recipientUserId,
      type,
      title,
      body,
      requestId,
      assignmentId,
      auditEventId,
      JSON.stringify(metadata),
      businessEventId,
    ]
  );

  return result.rows[0]?.id ?? null;
}

// ── SSE STREAM REGISTRY ────────────────────────────────────────────────────────

type SseConnection = {
  reply: FastifyReply;
  userId: string;
  organizationId: string;
};

export class SseStreamManager {
  private connections = new Map<string, Set<SseConnection>>();
  private heartbeatInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.heartbeatInterval = setInterval(() => this.sendHeartbeat(), 25000);
    if (this.heartbeatInterval.unref) this.heartbeatInterval.unref();
  }

  private userKey(organizationId: string, userId: string): string {
    return `${organizationId}:${userId}`;
  }

  public add(organizationId: string, userId: string, reply: FastifyReply) {
    const key = this.userKey(organizationId, userId);
    if (!this.connections.has(key)) {
      this.connections.set(key, new Set());
    }
    const conn: SseConnection = { reply, userId, organizationId };
    this.connections.get(key)!.add(conn);

    reply.raw.on('close', () => {
      this.remove(organizationId, userId, conn);
    });
  }

  public remove(organizationId: string, userId: string, conn: SseConnection) {
    const key = this.userKey(organizationId, userId);
    const set = this.connections.get(key);
    if (set) {
      set.delete(conn);
      if (set.size === 0) {
        this.connections.delete(key);
      }
    }
  }

  public broadcastToUser(organizationId: string, userId: string, event: string, data: any) {
    const key = this.userKey(organizationId, userId);
    const set = this.connections.get(key);
    if (!set || set.size === 0) return;

    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const conn of set) {
      try {
        conn.reply.raw.write(payload);
      } catch (err) {
        this.remove(organizationId, userId, conn);
      }
    }
  }

  private sendHeartbeat() {
    const ping = ': ping\n\n';
    for (const [key, set] of this.connections.entries()) {
      for (const conn of set) {
        try {
          conn.reply.raw.write(ping);
        } catch {
          set.delete(conn);
        }
      }
      if (set.size === 0) {
        this.connections.delete(key);
      }
    }
  }

  public getConnectionCount(): number {
    let count = 0;
    for (const set of this.connections.values()) {
      count += set.size;
    }
    return count;
  }

  public closeAll() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    for (const set of this.connections.values()) {
      for (const conn of set) {
        try {
          conn.reply.raw.end();
        } catch {}
      }
    }
    this.connections.clear();
  }
}

export const sseStreamManager = new SseStreamManager();

// ── OUTBOX DISPATCHER ─────────────────────────────────────────────────────────

let isDispatching = false;
let dispatchPending = false;

export function triggerDispatcher(pool: pg.Pool, config: AppConfig) {
  if (isDispatching) {
    dispatchPending = true;
    return;
  }
  setImmediate(() => {
    dispatchQueuedNotifications(pool, config).catch((err) => {
      logger.error('Background notification dispatch error', err);
    });
  });
}

export async function dispatchQueuedNotifications(
  pool: pg.Pool,
  config: AppConfig,
  customLogger = logger
): Promise<{ processed: number; sent: number; failed: number; skipped: number }> {
  if (isDispatching) {
    dispatchPending = true;
    return { processed: 0, sent: 0, failed: 0, skipped: 0 };
  }

  isDispatching = true;
  let processed = 0;
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  try {
    // 1. Recover stale SENDING locks older than 2 minutes
    await pool.query(
      `UPDATE notification_events
       SET dispatch_status = 'QUEUED', locked_at = NULL
       WHERE dispatch_status = 'SENDING' AND locked_at < now() - interval '2 minutes'`
    );

    // 2. Process batch of queued notifications
    while (true) {
      const client = await pool.connect();
      let batch: any[] = [];
      try {
        await client.query('BEGIN');
        const lockedRes = await client.query<{
          id: string;
          organization_id: string;
          recipient_user_id: string;
          type: NotificationType;
          title: string;
          body: string;
          request_id: string | null;
          assignment_id: string | null;
          audit_event_id: string | null;
          metadata: any;
          attempts: number;
          max_attempts: number;
          created_at: Date;
        }>(
          `SELECT id, organization_id, recipient_user_id, type, title, body,
                  request_id, assignment_id, audit_event_id, metadata, attempts, max_attempts, created_at
           FROM notification_events
           WHERE dispatch_status = 'QUEUED'
           ORDER BY created_at ASC
           LIMIT 25
           FOR UPDATE SKIP LOCKED`
        );

        batch = lockedRes.rows;
        if (lockedRes.rowCount === 0) {
          await client.query('COMMIT');
          break;
        }

        const ids = batch.map((r) => r.id);
        await client.query(
          `UPDATE notification_events
           SET dispatch_status = 'SENDING', locked_at = now(), attempts = attempts + 1
           WHERE id = ANY($1::uuid[])`,
          [ids]
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      // Batch fetch preferences and devices for all unique recipients in this batch (O(1) round trips)
      const uniqueUserIds = [...new Set(batch.map((r) => r.recipient_user_id))];

      const prefRows = await pool.query<{
        user_id: string;
        browser_push_enabled: boolean;
        sla_alerts: boolean;
        assignment_alerts: boolean;
        workflow_alerts: boolean;
        team_alerts: boolean;
        security_alerts: boolean;
      }>(
        `SELECT user_id, browser_push_enabled, sla_alerts, assignment_alerts, workflow_alerts, team_alerts, security_alerts
         FROM user_notification_preferences
         WHERE user_id = ANY($1::uuid[])`,
        [uniqueUserIds]
      );
      const prefsMap = new Map(prefRows.rows.map((p) => [p.user_id, p]));

      const deviceRows = await pool.query<{ id: string; user_id: string; fcm_token: string; token_hash: string }>(
        `SELECT id, user_id, fcm_token, token_hash
         FROM notification_devices
         WHERE user_id = ANY($1::uuid[]) AND revoked_at IS NULL`,
        [uniqueUserIds]
      );
      const devicesMap = new Map<string, { id: string; fcm_token: string; token_hash: string }[]>();
      for (const dev of deviceRows.rows) {
        let list = devicesMap.get(dev.user_id);
        if (!list) {
          list = [];
          devicesMap.set(dev.user_id, list);
        }
        list.push(dev);
      }

      const DEFAULT_PREFS = {
        browser_push_enabled: true,
        sla_alerts: true,
        assignment_alerts: true,
        workflow_alerts: true,
        team_alerts: true,
        security_alerts: true,
      };

      for (const item of batch) {
        processed++;
        const category = getNotificationCategory(item.type);
        const prefs = prefsMap.get(item.recipient_user_id) ?? DEFAULT_PREFS;

        // Check if category is enabled for push
        let categoryAllowed = true;
        if (category === 'sla') categoryAllowed = prefs.sla_alerts;
        else if (category === 'assignment') categoryAllowed = prefs.assignment_alerts;
        else if (category === 'workflow') categoryAllowed = prefs.workflow_alerts;
        else if (category === 'team') categoryAllowed = prefs.team_alerts;
        else if (category === 'security') categoryAllowed = prefs.security_alerts;

        const shouldSendPush = prefs.browser_push_enabled && categoryAllowed;

        // In-App Realtime SSE Broadcast (Always deliver in-app to active views)
        sseStreamManager.broadcastToUser(item.organization_id, item.recipient_user_id, 'notification', {
          id: item.id,
          type: item.type,
          title: item.title,
          body: item.body,
          requestId: item.request_id,
          metadata: item.metadata,
          category,
          createdAt: item.created_at,
        });

        // Record In-App attempt
        await pool.query(
          `INSERT INTO notification_delivery_attempts (notification_id, provider, status)
           VALUES ($1, 'in_app', 'SENT')`,
          [item.id]
        );

        if (!shouldSendPush) {
          await pool.query(
            `UPDATE notification_events
             SET dispatch_status = 'SKIPPED', dispatched_at = now(), locked_at = NULL
             WHERE id = $1`,
            [item.id]
          );
          skipped++;
          continue;
        }

        // Active devices for recipient from batch map
        const userDevices = devicesMap.get(item.recipient_user_id) ?? [];

        if (userDevices.length === 0) {
          await pool.query(
            `UPDATE notification_events
             SET dispatch_status = 'SKIPPED', dispatched_at = now(), locked_at = NULL
             WHERE id = $1`,
            [item.id]
          );
          skipped++;
          continue;
        }

        let pushSuccessCount = 0;
        let pushFailedCount = 0;
        let lastErr: string | null = null;

        for (const device of userDevices) {
          const clickAction = item.request_id
            ? `/?request=${encodeURIComponent(item.request_id)}`
            : category === 'team'
            ? '/?view=team'
            : '/';

          const fcmResult = await sendFcmPushNotification(
            {
              token: device.fcm_token,
              title: item.title,
              body: item.body,
              clickAction,
              data: {
                notificationId: item.id,
                type: item.type,
                requestId: item.request_id || '',
                category,
              },
            },
            config
          );

          // Record attempt
          await pool.query(
            `INSERT INTO notification_delivery_attempts (notification_id, device_id, provider, status, error_code, error_message)
             VALUES ($1, $2, 'fcm', $3, $4, $5)`,
            [item.id, device.id, fcmResult.status, fcmResult.errorCode || null, fcmResult.errorMessage || null]
          );

          if (fcmResult.status === 'REVOKED') {
            // Revoke invalid device token in DB
            await pool.query(
              `UPDATE notification_devices
               SET revoked_at = now()
               WHERE id = $1`,
              [device.id]
            );
            customLogger.info('Revoked invalid FCM device token', {
              deviceId: device.id,
              tokenFingerprint: tokenFingerprint(device.fcm_token),
            });
          }

          if (fcmResult.success || fcmResult.status === 'SKIPPED') {
            pushSuccessCount++;
          } else {
            pushFailedCount++;
            lastErr = fcmResult.errorMessage || fcmResult.errorCode || 'Push failed';
          }
        }

        if (pushSuccessCount > 0 || (userDevices.length > 0 && pushFailedCount === 0)) {
          await pool.query(
            `UPDATE notification_events
             SET dispatch_status = 'SENT', dispatched_at = now(), locked_at = NULL
             WHERE id = $1`,
            [item.id]
          );
          sent++;
        } else {
          const isFinal = item.attempts >= item.max_attempts;
          await pool.query(
            `UPDATE notification_events
             SET dispatch_status = $1, last_error = $2, locked_at = NULL
             WHERE id = $3`,
            [isFinal ? 'FAILED' : 'QUEUED', lastErr, item.id]
          );
          if (isFinal) failed++;
        }
      }
    }
  } finally {
    isDispatching = false;
    if (dispatchPending) {
      dispatchPending = false;
      triggerDispatcher(pool, config);
    }
  }

  return { processed, sent, failed, skipped };
}

// ── SCHEMAS ──────────────────────────────────────────────────────────────────

const registerDeviceSchema = z.object({
  fcmToken: z.string().min(10).max(4096),
  browser: z.string().max(100).optional(),
  deviceLabel: z.string().max(100).optional(),
});

const updatePreferencesSchema = z.object({
  browserPushEnabled: z.boolean().optional(),
  slaAlerts: z.boolean().optional(),
  assignmentAlerts: z.boolean().optional(),
  workflowAlerts: z.boolean().optional(),
  teamAlerts: z.boolean().optional(),
  securityAlerts: z.boolean().optional(),
});

// ── FASTIFY ROUTES ───────────────────────────────────────────────────────────

export function registerNotificationRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  config: AppConfig
) {
  // 1. GET /v1/notifications/stream — SSE Stream for live in-app notifications
  app.get('/v1/notifications/stream', async (request, reply) => {
    const user = await authenticatePm(request, pool, config);

    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.flushHeaders();

    // Query initial unread count
    const unreadRes = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::int AS count
       FROM notification_events
       WHERE recipient_user_id = $1 AND organization_id = $2 AND read_at IS NULL`,
      [user.id, user.organizationId]
    );
    const unreadCount = parseInt(unreadRes.rows[0]?.count || '0', 10);

    reply.raw.write(
      `event: connected\ndata: ${JSON.stringify({
        status: 'connected',
        userId: user.id,
        unreadCount,
      })}\n\n`
    );

    sseStreamManager.add(user.organizationId, user.id, reply);
  });

  // 2. POST /v1/notifications/devices — Register / bind FCM Token to authenticated session
  app.post('/v1/notifications/devices', async (request, reply) => {
    const user = await authenticatePm(request, pool, config);
    const parseResult = registerDeviceSchema.safeParse(request.body);
    if (!parseResult.success) {
      throw new ApiError(400, 'INVALID_INPUT', 'Valid fcmToken is required.');
    }

    const { fcmToken, browser, deviceLabel } = parseResult.data;
    const tokenHash = hashToken(fcmToken);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Check if this token was previously assigned to any other user/org or revoked
      const existing = await client.query<{ id: string; user_id: string; organization_id: string }>(
        `SELECT id, user_id, organization_id FROM notification_devices WHERE token_hash = $1 FOR UPDATE`,
        [tokenHash]
      );

      let deviceId: string;
      if (existing.rowCount && existing.rows[0]) {
        const row = existing.rows[0];
        // If token belonged to a different user, or was revoked, re-bind securely to current user
        const updateRes = await client.query<{ id: string }>(
          `UPDATE notification_devices
           SET user_id = $1, organization_id = $2, browser = COALESCE($3, browser),
               device_label = COALESCE($4, device_label), last_seen_at = now(), revoked_at = NULL
           WHERE id = $5
           RETURNING id`,
          [user.id, user.organizationId, browser ?? null, deviceLabel ?? null, row.id]
        );
        deviceId = updateRes.rows[0].id;
      } else {
        const insertRes = await client.query<{ id: string }>(
          `INSERT INTO notification_devices (
            organization_id, user_id, fcm_token, token_hash, browser, device_label, last_seen_at
          ) VALUES ($1, $2, $3, $4, $5, $6, now())
          RETURNING id`,
          [user.organizationId, user.id, fcmToken, tokenHash, browser ?? null, deviceLabel ?? null]
        );
        deviceId = insertRes.rows[0].id;
      }

      await client.query('COMMIT');
      logger.info('Registered FCM device token for user', {
        userId: user.id,
        tokenFingerprint: tokenFingerprint(fcmToken),
      });

      return reply.code(200).send({
        success: true,
        deviceId,
        registeredAt: new Date().toISOString(),
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });

  // 3. DELETE /v1/notifications/devices/:id — Revoke FCM device token
  app.delete<{ Params: { id: string } }>('/v1/notifications/devices/:id', async (request, reply) => {
    const user = await authenticatePm(request, pool, config);
    const deviceId = request.params.id;

    const res = await pool.query(
      `UPDATE notification_devices
       SET revoked_at = now()
       WHERE id = $1 AND user_id = $2 AND organization_id = $3 AND revoked_at IS NULL`,
      [deviceId, user.id, user.organizationId]
    );

    if (res.rowCount === 0) {
      throw new ApiError(404, 'DEVICE_NOT_FOUND', 'Device token not found or already revoked.');
    }

    return reply.code(200).send({ success: true, revokedAt: new Date().toISOString() });
  });

  // 4. GET /v1/notifications — List notifications with pagination
  app.get('/v1/notifications', async (request, reply) => {
    const user = await authenticatePm(request, pool, config);
    const query = request.query as { limit?: string; before?: string; unreadOnly?: string };

    const limit = Math.min(Math.max(parseInt(query.limit || '20', 10) || 20, 1), 100);
    const before = query.before ? new Date(query.before) : null;
    const unreadOnly = query.unreadOnly === 'true';

    const conditions: string[] = ['recipient_user_id = $1', 'organization_id = $2'];
    const params: any[] = [user.id, user.organizationId];

    if (unreadOnly) {
      conditions.push('read_at IS NULL');
    }

    if (before && !isNaN(before.getTime())) {
      params.push(before);
      conditions.push(`created_at < $${params.length}`);
    }

    params.push(limit + 1);
    const querySql = `
      SELECT id, organization_id, recipient_user_id, type, title, body,
             request_id, assignment_id, audit_event_id, metadata, read_at, created_at
      FROM notification_events
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT $${params.length}
    `;

    const result = await pool.query<{
      id: string;
      organization_id: string;
      recipient_user_id: string;
      type: NotificationType;
      title: string;
      body: string;
      request_id: string | null;
      assignment_id: string | null;
      audit_event_id: string | null;
      metadata: any;
      read_at: Date | null;
      created_at: Date;
    }>(querySql, params);

    const hasMore = result.rows.length > limit;
    const rows = hasMore ? result.rows.slice(0, limit) : result.rows;

    const unreadRes = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::int AS count
       FROM notification_events
       WHERE recipient_user_id = $1 AND organization_id = $2 AND read_at IS NULL`,
      [user.id, user.organizationId]
    );
    const unreadCount = parseInt(unreadRes.rows[0]?.count || '0', 10);

    return reply.code(200).send({
      notifications: rows.map((r) => ({
        id: r.id,
        type: r.type,
        title: r.title,
        body: r.body,
        requestId: r.request_id,
        assignmentId: r.assignment_id,
        auditEventId: r.audit_event_id,
        metadata: r.metadata,
        category: getNotificationCategory(r.type),
        readAt: r.read_at,
        createdAt: r.created_at,
      })),
      unreadCount,
      hasMore,
    });
  });

  // 5. GET /v1/notifications/unread-count
  app.get('/v1/notifications/unread-count', async (request, reply) => {
    const user = await authenticatePm(request, pool, config);
    const unreadRes = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::int AS count
       FROM notification_events
       WHERE recipient_user_id = $1 AND organization_id = $2 AND read_at IS NULL`,
      [user.id, user.organizationId]
    );
    return reply.code(200).send({ unreadCount: parseInt(unreadRes.rows[0]?.count || '0', 10) });
  });

  // 6. POST /v1/notifications/:id/read — Mark single notification as read
  app.post<{ Params: { id: string } }>('/v1/notifications/:id/read', async (request, reply) => {
    const user = await authenticatePm(request, pool, config);
    const notificationId = request.params.id;

    const res = await pool.query<{
      id: string;
      read_at: Date;
    }>(
      `UPDATE notification_events
       SET read_at = now()
       WHERE id = $1 AND recipient_user_id = $2 AND organization_id = $3
       RETURNING id, read_at`,
      [notificationId, user.id, user.organizationId]
    );

    if (res.rowCount === 0) {
      throw new ApiError(404, 'NOTIFICATION_NOT_FOUND', 'Notification not found.');
    }

    // Query fresh unread count
    const unreadRes = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::int AS count
       FROM notification_events
       WHERE recipient_user_id = $1 AND organization_id = $2 AND read_at IS NULL`,
      [user.id, user.organizationId]
    );
    const unreadCount = parseInt(unreadRes.rows[0]?.count || '0', 10);

    sseStreamManager.broadcastToUser(user.organizationId, user.id, 'unread_count', { unreadCount });

    return reply.code(200).send({
      success: true,
      notificationId: res.rows[0].id,
      readAt: res.rows[0].read_at,
      unreadCount,
    });
  });

  // 7. POST /v1/notifications/read-all — Mark all notifications as read
  app.post('/v1/notifications/read-all', async (request, reply) => {
    const user = await authenticatePm(request, pool, config);

    const res = await pool.query(
      `UPDATE notification_events
       SET read_at = now()
       WHERE recipient_user_id = $1 AND organization_id = $2 AND read_at IS NULL`,
      [user.id, user.organizationId]
    );

    sseStreamManager.broadcastToUser(user.organizationId, user.id, 'unread_count', { unreadCount: 0 });

    return reply.code(200).send({
      success: true,
      markedCount: res.rowCount ?? 0,
      unreadCount: 0,
    });
  });

  // 8. DELETE /v1/notifications/:id — Delete / Dismiss a single notification
  app.delete<{ Params: { id: string } }>('/v1/notifications/:id', async (request, reply) => {
    const user = await authenticatePm(request, pool, config);
    const notificationId = request.params.id;

    const res = await pool.query(
      `DELETE FROM notification_events
       WHERE id = $1 AND recipient_user_id = $2 AND organization_id = $3`,
      [notificationId, user.id, user.organizationId]
    );

    if (res.rowCount === 0) {
      throw new ApiError(404, 'NOTIFICATION_NOT_FOUND', 'Notification not found.');
    }

    // Query fresh unread count
    const unreadRes = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::int AS count
       FROM notification_events
       WHERE recipient_user_id = $1 AND organization_id = $2 AND read_at IS NULL`,
      [user.id, user.organizationId]
    );
    const unreadCount = parseInt(unreadRes.rows[0]?.count || '0', 10);
    sseStreamManager.broadcastToUser(user.organizationId, user.id, 'unread_count', { unreadCount });

    return reply.code(200).send({
      success: true,
      deletedId: notificationId,
      unreadCount,
    });
  });

  // 9. DELETE /v1/notifications — Clear all notifications for user
  app.delete('/v1/notifications', async (request, reply) => {
    const user = await authenticatePm(request, pool, config);

    const res = await pool.query(
      `DELETE FROM notification_events
       WHERE recipient_user_id = $1 AND organization_id = $2`,
      [user.id, user.organizationId]
    );

    sseStreamManager.broadcastToUser(user.organizationId, user.id, 'unread_count', { unreadCount: 0 });

    return reply.code(200).send({
      success: true,
      clearedCount: res.rowCount ?? 0,
      unreadCount: 0,
    });
  });

  // 8. GET /v1/notifications/preferences
  app.get('/v1/notifications/preferences', async (request, reply) => {
    const user = await authenticatePm(request, pool, config);

    const res = await pool.query<{
      browser_push_enabled: boolean;
      sla_alerts: boolean;
      assignment_alerts: boolean;
      workflow_alerts: boolean;
      team_alerts: boolean;
      security_alerts: boolean;
      updated_at: Date;
    }>(
      `SELECT browser_push_enabled, sla_alerts, assignment_alerts, workflow_alerts, team_alerts, security_alerts, updated_at
       FROM user_notification_preferences
       WHERE user_id = $1 AND organization_id = $2`,
      [user.id, user.organizationId]
    );

    if (res.rowCount && res.rows[0]) {
      const row = res.rows[0];
      return reply.code(200).send({
        preferences: {
          browserPushEnabled: row.browser_push_enabled,
          slaAlerts: row.sla_alerts,
          assignmentAlerts: row.assignment_alerts,
          workflowAlerts: row.workflow_alerts,
          teamAlerts: row.team_alerts,
          securityAlerts: row.security_alerts,
          updatedAt: row.updated_at,
        },
      });
    }

    return reply.code(200).send({
      preferences: {
        browserPushEnabled: true,
        slaAlerts: true,
        assignmentAlerts: true,
        workflowAlerts: true,
        teamAlerts: true,
        securityAlerts: true,
        updatedAt: new Date().toISOString(),
      },
    });
  });

  // 9. PATCH /v1/notifications/preferences
  app.patch('/v1/notifications/preferences', async (request, reply) => {
    const user = await authenticatePm(request, pool, config);
    const parseResult = updatePreferencesSchema.safeParse(request.body);
    if (!parseResult.success) {
      throw new ApiError(400, 'INVALID_INPUT', 'Invalid preferences payload.');
    }

    const {
      browserPushEnabled,
      slaAlerts,
      assignmentAlerts,
      workflowAlerts,
      teamAlerts,
      securityAlerts,
    } = parseResult.data;

    const res = await pool.query<{
      browser_push_enabled: boolean;
      sla_alerts: boolean;
      assignment_alerts: boolean;
      workflow_alerts: boolean;
      team_alerts: boolean;
      security_alerts: boolean;
      updated_at: Date;
    }>(
      `INSERT INTO user_notification_preferences (
        user_id, organization_id, browser_push_enabled, sla_alerts, assignment_alerts, workflow_alerts, team_alerts, security_alerts
      ) VALUES ($1, $2, COALESCE($3, true), COALESCE($4, true), COALESCE($5, true), COALESCE($6, true), COALESCE($7, true), COALESCE($8, true))
      ON CONFLICT (user_id) DO UPDATE SET
        browser_push_enabled = COALESCE($3, user_notification_preferences.browser_push_enabled),
        sla_alerts = COALESCE($4, user_notification_preferences.sla_alerts),
        assignment_alerts = COALESCE($5, user_notification_preferences.assignment_alerts),
        workflow_alerts = COALESCE($6, user_notification_preferences.workflow_alerts),
        team_alerts = COALESCE($7, user_notification_preferences.team_alerts),
        security_alerts = COALESCE($8, user_notification_preferences.security_alerts),
        updated_at = now()
      RETURNING browser_push_enabled, sla_alerts, assignment_alerts, workflow_alerts, team_alerts, security_alerts, updated_at`,
      [
        user.id,
        user.organizationId,
        browserPushEnabled ?? null,
        slaAlerts ?? null,
        assignmentAlerts ?? null,
        workflowAlerts ?? null,
        teamAlerts ?? null,
        securityAlerts ?? null,
      ]
    );

    const row = res.rows[0];
    return reply.code(200).send({
      success: true,
      preferences: {
        browserPushEnabled: row.browser_push_enabled,
        slaAlerts: row.sla_alerts,
        assignmentAlerts: row.assignment_alerts,
        workflowAlerts: row.workflow_alerts,
        teamAlerts: row.team_alerts,
        securityAlerts: row.security_alerts,
        updatedAt: row.updated_at,
      },
    });
  });
}
