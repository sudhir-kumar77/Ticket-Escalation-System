-- 0013_notifications.sql
-- Production-grade notification subsystem: notification_events, notification_devices, notification_delivery_attempts, user_notification_preferences

-- 1. Notification Events (Canonical PostgreSQL Outbox & History)
CREATE TABLE IF NOT EXISTS notification_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  recipient_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  request_id uuid REFERENCES requests(id) ON DELETE CASCADE,
  assignment_id uuid REFERENCES assignments(id) ON DELETE SET NULL,
  audit_event_id uuid REFERENCES audit_events(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  business_event_id text NULL,
  dispatch_status text NOT NULL DEFAULT 'QUEUED' CHECK (dispatch_status IN ('QUEUED', 'SENDING', 'SENT', 'FAILED', 'SKIPPED')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  last_error text NULL,
  locked_at timestamptz NULL,
  dispatched_at timestamptz NULL,
  read_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes for notification_events
CREATE INDEX IF NOT EXISTS idx_notification_events_recipient_created ON notification_events (recipient_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_events_org_created ON notification_events (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_events_unread ON notification_events (recipient_user_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notification_events_queued ON notification_events (dispatch_status, created_at ASC) WHERE dispatch_status IN ('QUEUED', 'SENDING');
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_events_dedup ON notification_events (organization_id, recipient_user_id, type, business_event_id) WHERE business_event_id IS NOT NULL;

-- 2. Notification Devices (FCM Device Tokens)
CREATE TABLE IF NOT EXISTS notification_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fcm_token text NOT NULL,
  token_hash text NOT NULL,
  browser text NULL,
  device_label text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NULL,
  revoked_at timestamptz NULL
);

-- Indexes for notification_devices
CREATE INDEX IF NOT EXISTS idx_notification_devices_user_active ON notification_devices (user_id, organization_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notification_devices_token_hash ON notification_devices (token_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_devices_active_token ON notification_devices (token_hash) WHERE revoked_at IS NULL;

-- 3. Notification Delivery Attempts (Audit & Diagnostics per Attempt)
CREATE TABLE IF NOT EXISTS notification_delivery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
  device_id uuid REFERENCES notification_devices(id) ON DELETE SET NULL,
  provider text NOT NULL CHECK (provider IN ('fcm', 'in_app', 'sse')),
  status text NOT NULL CHECK (status IN ('SENT', 'FAILED', 'REVOKED', 'SKIPPED')),
  error_code text NULL,
  error_message text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notification_delivery_attempts_notif ON notification_delivery_attempts (notification_id, created_at DESC);

-- 4. User Notification Preferences (Authoritative Server-Side User Settings)
CREATE TABLE IF NOT EXISTS user_notification_preferences (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  browser_push_enabled boolean NOT NULL DEFAULT true,
  sla_alerts boolean NOT NULL DEFAULT true,
  assignment_alerts boolean NOT NULL DEFAULT true,
  workflow_alerts boolean NOT NULL DEFAULT true,
  team_alerts boolean NOT NULL DEFAULT true,
  security_alerts boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_notification_preferences_org ON user_notification_preferences (organization_id);

-- Update trigger for updated_at on notification_events
CREATE OR REPLACE FUNCTION update_notification_events_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS notification_events_updated_at ON notification_events;
CREATE TRIGGER notification_events_updated_at
  BEFORE UPDATE ON notification_events
  FOR EACH ROW EXECUTE FUNCTION update_notification_events_updated_at();

-- Update trigger for updated_at on user_notification_preferences
CREATE OR REPLACE FUNCTION update_user_notification_preferences_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_notification_preferences_updated_at ON user_notification_preferences;
CREATE TRIGGER user_notification_preferences_updated_at
  BEFORE UPDATE ON user_notification_preferences
  FOR EACH ROW EXECUTE FUNCTION update_user_notification_preferences_updated_at();
