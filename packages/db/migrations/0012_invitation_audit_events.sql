-- 0012_invitation_audit_events.sql
-- Expand audit_event_type_allowed check constraint for invitation lifecycle & archiving

ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_event_type_allowed;
ALTER TABLE audit_events ADD CONSTRAINT audit_event_type_allowed CHECK (
  event_type IN (
    'request_created',
    'assigned',
    'reassigned',
    'acknowledged',
    'work_started',
    'resolved',
    'request_deleted',
    'request_archived',
    'sla_breached',
    'escalation_triggered',
    'USER_INVITED',
    'INVITATION_RESENT',
    'USER_ONBOARDED',
    'INVITATION_CONFIRMED',
    'USER_CREATED',
    'USER_DEACTIVATED',
    'USER_REACTIVATED',
    'ROLE_CHANGED',
    'PASSWORD_CHANGED',
    'PASSWORD_RESET_REQUESTED',
    'PASSWORD_RESET_COMPLETED',
    'SESSIONS_REVOKED',
    'REMOTE_SESSIONS_REVOKED',
    'AUDIT_LOG_DELETED',
    'AUDIT_TRAIL_PURGED'
  )
);
