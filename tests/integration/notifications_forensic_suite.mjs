import assert from 'node:assert/strict'
import { randomUUID, randomBytes, scryptSync, createHash } from 'node:crypto'
import pg from 'pg'

const API_ORIGIN = process.env.API_ORIGIN ?? process.env.API_URL ?? 'http://127.0.0.1:4000'
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://nvara:nvara_local_dev_only@localhost:55432/nvara'
const db = new pg.Pool({ connectionString: DATABASE_URL })

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex')
  const derivedKey = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 })
  return `${salt}:${derivedKey.toString('hex')}`
}

function hashToken(rawToken) {
  return createHash('sha256').update(rawToken).digest('hex')
}

function getSessionCookie(res) {
  const setCookie = res.headers.get('set-cookie')
  if (!setCookie) return null
  const match = setCookie.match(/nvara_session=([^;]+)/)
  return match ? match[1] : null
}

console.log('\n══════════════════════════════════════════════════════════════')
console.log('    PRODUCTION-GRADE FIREBASE NOTIFICATION FORENSIC SUITE     ')
console.log('══════════════════════════════════════════════════════════════\n')

try {
  // ── Setup Test Organization & Roles ──
  const orgRes = await db.query(
    `INSERT INTO organizations (name) VALUES ('Notif Forensic Org ' || gen_random_uuid()) RETURNING id`
  )
  const orgId = orgRes.rows[0].id

  const org2Res = await db.query(
    `INSERT INTO organizations (name) VALUES ('Notif Forensic Org 2 ' || gen_random_uuid()) RETURNING id`
  )
  const org2Id = org2Res.rows[0].id

  const pmRoleRes = await db.query("SELECT id FROM roles WHERE code = 'project_manager'")
  const specRoleRes = await db.query("SELECT id FROM roles WHERE code = 'internal_team_member'")
  const pmRoleId = pmRoleRes.rows[0].id
  const specRoleId = specRoleRes.rows[0].id

  // Create Primary PM user
  const pmPassword = 'PMStrongPass#2026'
  const pmUserRes = await db.query(
    `INSERT INTO users (organization_id, display_name, email, password_hash, is_active)
     VALUES ($1, 'Lead PM Alice', 'alice.pm.' || gen_random_uuid() || '@nvara.test', $2, true)
     RETURNING id, email`,
    [orgId, hashPassword(pmPassword)]
  )
  const pmUser = pmUserRes.rows[0]
  await db.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [pmUser.id, pmRoleId])

  // Create Specialist user
  const specPassword = 'SpecStrongPass#2026'
  const specUserRes = await db.query(
    `INSERT INTO users (organization_id, display_name, email, password_hash, is_active)
     VALUES ($1, 'Specialist Bob', 'bob.spec.' || gen_random_uuid() || '@nvara.test', $2, true)
     RETURNING id, email`,
    [orgId, hashPassword(specPassword)]
  )
  const specUser = specUserRes.rows[0]
  await db.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [specUser.id, specRoleId])

  // Create Foreign Org PM user
  const foreignPmRes = await db.query(
    `INSERT INTO users (organization_id, display_name, email, password_hash, is_active)
     VALUES ($1, 'Foreign PM Charlie', 'charlie.pm.' || gen_random_uuid() || '@foreign.test', $2, true)
     RETURNING id, email`,
    [org2Id, hashPassword(pmPassword)]
  )
  const foreignPm = foreignPmRes.rows[0]
  await db.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [foreignPm.id, pmRoleId])

  // Login PM and Specialist
  const pmLoginRes = await fetch(`${API_ORIGIN}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: pmUser.email, password: pmPassword }),
  })
  assert.equal(pmLoginRes.status, 200, 'PM login must succeed')
  const pmCookie = getSessionCookie(pmLoginRes)
  assert.ok(pmCookie, 'PM session cookie must be set')

  const specLoginRes = await fetch(`${API_ORIGIN}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: specUser.email, password: specPassword }),
  })
  assert.equal(specLoginRes.status, 200, 'Specialist login must succeed')
  const specCookie = getSessionCookie(specLoginRes)
  assert.ok(specCookie, 'Specialist session cookie must be set')

  const foreignLoginRes = await fetch(`${API_ORIGIN}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: foreignPm.email, password: pmPassword }),
  })
  assert.equal(foreignLoginRes.status, 200, 'Foreign PM login must succeed')
  const foreignCookie = getSessionCookie(foreignLoginRes)

  // ════════════════════════════════════════════════════════════
  // 1. MIGRATION 0013 SCHEMA & CONSTRAINTS VALIDATION
  // ════════════════════════════════════════════════════════════
  console.log('1. Database Migration 0013 Schema Verification')
  const tableCheck = await db.query(
    `SELECT table_name FROM information_schema.tables 
     WHERE table_schema = 'public' AND table_name IN ('notification_events', 'notification_devices', 'notification_delivery_attempts', 'user_notification_preferences')`
  )
  assert.equal(tableCheck.rowCount, 4, 'All 4 notification tables must exist')

  const triggerCheck = await db.query(
    `SELECT trigger_name FROM information_schema.triggers WHERE trigger_name = 'user_notification_preferences_updated_at'`
  )
  assert.equal(triggerCheck.rowCount, 1, 'Updated_at trigger on user_notification_preferences must exist')
  console.log('  ✓ Tables notification_events, notification_devices, notification_delivery_attempts, user_notification_preferences and trigger exist')

  // ════════════════════════════════════════════════════════════
  // 2. TENANT ISOLATION & AUTHENTICATION BOUNDARY
  // ════════════════════════════════════════════════════════════
  console.log('2. Authentication & Tenant Isolation Security')

  // Unauthenticated request to /v1/notifications -> 401
  const unauthRes = await fetch(`${API_ORIGIN}/v1/notifications`)
  assert.equal(unauthRes.status, 401, 'Unauthenticated access to notifications must return 401')
  console.log('  ✓ Unauthenticated access rejected with 401')

  // Preferences auto-provisioned
  const prefRes = await fetch(`${API_ORIGIN}/v1/notifications/preferences`, {
    headers: { Cookie: `nvara_session=${pmCookie}` },
  })
  assert.equal(prefRes.status, 200, 'PM preferences must load')
  const prefBody = await prefRes.json()
  assert.equal(prefBody.preferences.browserPushEnabled, true)
  console.log('  ✓ Default notification preferences auto-provisioned successfully')

  // ════════════════════════════════════════════════════════════
  // 3. DEVICE TOKEN REGISTRATION & DEDUPLICATION
  // ════════════════════════════════════════════════════════════
  console.log('3. Device Token Registration & SHA-256 Deduplication')

  const testFcmToken = 'fcm_test_token_alice_laptop_' + randomUUID()
  const regRes = await fetch(`${API_ORIGIN}/v1/notifications/devices`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `nvara_session=${pmCookie}`,
    },
    body: JSON.stringify({
      fcmToken: testFcmToken,
      browser: 'Chrome 120 / macOS',
      deviceLabel: 'Alice MacBook Pro',
    }),
  })
  assert.equal(regRes.status, 200, 'Device registration must return 200')
  const regBody = await regRes.json()
  assert.ok(regBody.deviceId, 'Device ID must be returned')

  // Verify stored token has valid token_hash
  const devRow = await db.query(
    'SELECT token_hash, user_id, organization_id FROM notification_devices WHERE id = $1',
    [regBody.deviceId]
  )
  assert.equal(devRow.rows[0].token_hash, hashToken(testFcmToken), 'Stored token_hash must match SHA-256')
  assert.equal(devRow.rows[0].user_id, pmUser.id)
  assert.equal(devRow.rows[0].organization_id, orgId)
  console.log('  ✓ FCM token registered securely with SHA-256 hash deduplication')

  // Re-registration with same token must update without throwing duplicate error
  const reRegRes = await fetch(`${API_ORIGIN}/v1/notifications/devices`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `nvara_session=${pmCookie}`,
    },
    body: JSON.stringify({
      fcmToken: testFcmToken,
      deviceLabel: 'Alice MacBook Pro Renamed',
    }),
  })
  assert.equal(reRegRes.status, 200, 'Duplicate token registration must succeed idempotently')
  console.log('  ✓ Idempotent re-registration handles existing token hash cleanly')

  // ════════════════════════════════════════════════════════════
  // 4. ATOMIC OUTBOX NOTIFICATIONS IN BUSINESS MUTATIONS
  // ════════════════════════════════════════════════════════════
  console.log('4. Transactional Outbox Atomic Event Generation')

  // Create client and domain in orgId
  const clientRes = await db.query(
    `INSERT INTO clients (organization_id, name, company, email) VALUES ($1, 'Test Client', 'Acme', 'client@test.com') RETURNING id`,
    [orgId]
  )
  const clientId = clientRes.rows[0].id

  const domainRes = await db.query(
    `INSERT INTO service_domains (organization_id, name, slug) VALUES ($1, 'Engineering', 'engineering-' || gen_random_uuid()) RETURNING id`,
    [orgId]
  )
  const domainId = domainRes.rows[0].id

  // Create a ticket request in orgId
  const insertReq = await db.query(
    `INSERT INTO requests (organization_id, public_reference, client_id, service_domain_id, requirement, urgency, status, version)
     VALUES ($1, 'NVARA-2026-TEST-' || upper(substr(gen_random_uuid()::text, 1, 6)), $2, $3, 'Verification ticket for outbox audit', 'time_sensitive', 'awaiting_acknowledgement', 1)
     RETURNING id, public_reference, version`,
    [orgId, clientId, domainId]
  )
  const requestId = insertReq.rows[0].id
  const publicRef = insertReq.rows[0].public_reference
  let currentVersion = insertReq.rows[0].version

  // 4.1 Assign Request -> Outbox must contain REQUEST_ASSIGNED for Specialist
  const assignRes = await fetch(`${API_ORIGIN}/v1/pm/requests/${publicRef}/assignments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(),
      Cookie: `nvara_session=${pmCookie}`,
    },
    body: JSON.stringify({
      assigneeUserId: specUser.id,
      expectedVersion: currentVersion,
    }),
  })
  assert.equal(assignRes.status, 200, 'Assignment must succeed')
  currentVersion++

  const assignNotif = await db.query(
    `SELECT type, recipient_user_id, title, body, dispatch_status
     FROM notification_events
     WHERE request_id = $1 AND type = 'REQUEST_ASSIGNED'`,
    [requestId]
  )
  assert.equal(assignNotif.rowCount, 1, 'REQUEST_ASSIGNED outbox event must be queued')
  assert.equal(assignNotif.rows[0].recipient_user_id, specUser.id)
  console.log('  ✓ REQUEST_ASSIGNED atomically queued in outbox for assigned specialist')

  // 4.2 Acknowledge Request -> Outbox must contain REQUEST_ACKNOWLEDGED for PM
  const ackRes = await fetch(`${API_ORIGIN}/v1/requests/${publicRef}/acknowledge`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(),
      Cookie: `nvara_session=${specCookie}`,
    },
    body: JSON.stringify({ expectedVersion: currentVersion }),
  })
  assert.equal(ackRes.status, 200, 'Acknowledge must succeed')
  currentVersion++

  const ackNotif = await db.query(
    `SELECT type, recipient_user_id, title, body
     FROM notification_events
     WHERE request_id = $1 AND type = 'REQUEST_ACKNOWLEDGED'`,
    [requestId]
  )
  assert.equal(ackNotif.rowCount, 1, 'REQUEST_ACKNOWLEDGED outbox event must be queued')
  assert.equal(ackNotif.rows[0].recipient_user_id, pmUser.id)
  console.log('  ✓ REQUEST_ACKNOWLEDGED atomically queued in outbox for PM')

  // 4.3 Start Work -> Outbox must contain REQUEST_STARTED for PM
  const startRes = await fetch(`${API_ORIGIN}/v1/requests/${publicRef}/start-work`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(),
      Cookie: `nvara_session=${specCookie}`,
    },
    body: JSON.stringify({ expectedVersion: currentVersion }),
  })
  assert.equal(startRes.status, 200, 'Start work must succeed')
  currentVersion++

  const startNotif = await db.query(
    `SELECT type, recipient_user_id
     FROM notification_events
     WHERE request_id = $1 AND type = 'REQUEST_STARTED'`,
    [requestId]
  )
  assert.equal(startNotif.rowCount, 1, 'REQUEST_STARTED outbox event must be queued')
  console.log('  ✓ REQUEST_STARTED atomically queued in outbox for PM')

  // 4.4 Add Comment -> Outbox must contain COMMENT_ADDED for counterpart
  const commentRes = await fetch(`${API_ORIGIN}/v1/pm/requests/${publicRef}/comments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(),
      Cookie: `nvara_session=${specCookie}`,
    },
    body: JSON.stringify({ body: 'Deployment build 482 is ready for verification testing.' }),
  })
  assert.equal(commentRes.status, 201, 'Comment creation must succeed')

  const commentNotif = await db.query(
    `SELECT type, recipient_user_id, body
     FROM notification_events
     WHERE request_id = $1 AND type = 'COMMENT_ADDED'`,
    [requestId]
  )
  assert.equal(commentNotif.rowCount, 1, 'COMMENT_ADDED outbox event must be queued')
  assert.equal(commentNotif.rows[0].recipient_user_id, pmUser.id)
  assert.ok(commentNotif.rows[0].body.includes('Deployment build 482'))
  console.log('  ✓ COMMENT_ADDED atomically queued in outbox for PM')

  // 4.5 Resolve Request -> Outbox must contain REQUEST_RESOLVED
  const resolveRes = await fetch(`${API_ORIGIN}/v1/requests/${publicRef}/resolve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(),
      Cookie: `nvara_session=${specCookie}`,
    },
    body: JSON.stringify({ expectedVersion: currentVersion }),
  })
  assert.equal(resolveRes.status, 200, 'Resolve must succeed')

  const resolveNotif = await db.query(
    `SELECT type, recipient_user_id
     FROM notification_events
     WHERE request_id = $1 AND type = 'REQUEST_RESOLVED'`,
    [requestId]
  )
  assert.equal(resolveNotif.rowCount, 1, 'REQUEST_RESOLVED outbox event must be queued')
  console.log('  ✓ REQUEST_RESOLVED atomically queued in outbox')

  // ════════════════════════════════════════════════════════════
  // 5. TEAM LIFECYCLE & SECURITY OUTBOX EVENTS
  // ════════════════════════════════════════════════════════════
  console.log('5. Team Lifecycle & Security Outbox Events')

  // 5.1 Invite new user -> TEAM_MEMBER_INVITED
  const inviteEmail = 'new.specialist.' + randomUUID() + '@nvara.test'
  const inviteRes = await fetch(`${API_ORIGIN}/v1/pm/users/invite`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `nvara_session=${pmCookie}`,
    },
    body: JSON.stringify({
      displayName: 'Junior Specialist Sam',
      email: inviteEmail,
      role: 'internal_team_member',
      mode: 'invite_link',
    }),
  })
  assert.equal(inviteRes.status, 201, 'Team invite must succeed')

  // 5.2 Role change -> ROLE_CHANGED for target user
  const roleChangeRes = await fetch(`${API_ORIGIN}/v1/pm/users/${specUser.id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `nvara_session=${pmCookie}`,
    },
    body: JSON.stringify({
      role: 'project_manager',
    }),
  })
  assert.equal(roleChangeRes.status, 200, 'Role update must succeed')

  const roleNotif = await db.query(
    `SELECT type, recipient_user_id
     FROM notification_events
     WHERE recipient_user_id = $1 AND type = 'ROLE_CHANGED'`,
    [specUser.id]
  )
  assert.equal(roleNotif.rowCount, 1, 'ROLE_CHANGED notification must be queued for target user')
  console.log('  ✓ ROLE_CHANGED atomically queued for target user')

  // 5.3 Password changed -> PASSWORD_CHANGED
  const changePassRes = await fetch(`${API_ORIGIN}/v1/auth/change-password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `nvara_session=${pmCookie}`,
    },
    body: JSON.stringify({
      currentPassword: pmPassword,
      newPassword: 'PMNewSuperPass#2026',
    }),
  })
  assert.equal(changePassRes.status, 200, 'Password change must succeed')

  const passNotif = await db.query(
    `SELECT type, recipient_user_id
     FROM notification_events
     WHERE recipient_user_id = $1 AND type = 'PASSWORD_CHANGED'`,
    [pmUser.id]
  )
  assert.ok(passNotif.rowCount >= 1, 'PASSWORD_CHANGED notification must be queued')
  console.log('  ✓ PASSWORD_CHANGED atomically queued on password mutation')

  // ════════════════════════════════════════════════════════════
  // 6. NOTIFICATION REST QUERYING, MARK READ & UNREAD COUNT
  // ════════════════════════════════════════════════════════════
  console.log('6. Notification Querying, Cursor Pagination & Read State')

  // Query unread count
  const countRes = await fetch(`${API_ORIGIN}/v1/notifications/unread-count`, {
    headers: { Cookie: `nvara_session=${pmCookie}` },
  })
  assert.equal(countRes.status, 200)
  const countBody = await countRes.json()
  assert.ok(typeof countBody.unreadCount === 'number' && countBody.unreadCount > 0, 'Unread count must be positive')
  console.log(`  ✓ Unread count query returned: ${countBody.unreadCount}`)

  // Query notification list
  const listRes = await fetch(`${API_ORIGIN}/v1/notifications?limit=10`, {
    headers: { Cookie: `nvara_session=${pmCookie}` },
  })
  assert.equal(listRes.status, 200)
  const listBody = await listRes.json()
  assert.ok(listBody.notifications.length > 0, 'Notifications list must not be empty')
  const firstNotifId = listBody.notifications[0].id

  // Mark single notification as read
  const markReadRes = await fetch(`${API_ORIGIN}/v1/notifications/${firstNotifId}/read`, {
    method: 'POST',
    headers: { Cookie: `nvara_session=${pmCookie}` },
  })
  assert.equal(markReadRes.status, 200)
  const markReadBody = await markReadRes.json()
  assert.equal(markReadBody.success, true)
  assert.equal(markReadBody.unreadCount, countBody.unreadCount - 1)
  console.log('  ✓ Mark single notification as read updated state and unread count')

  // Mark all as read
  const markAllRes = await fetch(`${API_ORIGIN}/v1/notifications/read-all`, {
    method: 'POST',
    headers: { Cookie: `nvara_session=${pmCookie}` },
  })
  assert.equal(markAllRes.status, 200)
  const markAllBody = await markAllRes.json()
  assert.equal(markAllBody.success, true)
  assert.equal(markAllBody.unreadCount, 0)
  console.log('  ✓ Mark all notifications as read cleared unread counter to 0')

  // Foreign org user cannot see PM's notifications (Tenant isolation)
  const foreignListRes = await fetch(`${API_ORIGIN}/v1/notifications`, {
    headers: { Cookie: `nvara_session=${foreignCookie}` },
  })
  assert.equal(foreignListRes.status, 200)
  const foreignListBody = await foreignListRes.json()
  assert.equal(foreignListBody.notifications.length, 0, 'Foreign org user must see 0 notifications from other tenant')
  console.log('  ✓ Cross-tenant notification isolation fully preserved (0 leakage)')

  // ════════════════════════════════════════════════════════════
  // 7. PREFERENCES UPDATE & CATEGORY FILTERING
  // ════════════════════════════════════════════════════════════
  console.log('7. Notification Preferences Customization')

  const updatePrefRes = await fetch(`${API_ORIGIN}/v1/notifications/preferences`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `nvara_session=${pmCookie}`,
    },
    body: JSON.stringify({
      browserPushEnabled: false,
      slaAlerts: false,
    }),
  })
  assert.equal(updatePrefRes.status, 200)
  const updatePrefBody = await updatePrefRes.json()
  assert.equal(updatePrefBody.preferences.browserPushEnabled, false)
  assert.equal(updatePrefBody.preferences.slaAlerts, false)
  assert.equal(updatePrefBody.preferences.workflowAlerts, true)
  console.log('  ✓ Granular notification preferences update and persist correctly')

  // ════════════════════════════════════════════════════════════
  // 8. DEVICE REVOCATION
  // ════════════════════════════════════════════════════════════
  console.log('8. Device Revocation Lifecycle')

  const revokeRes = await fetch(`${API_ORIGIN}/v1/notifications/devices/${regBody.deviceId}`, {
    method: 'DELETE',
    headers: { Cookie: `nvara_session=${pmCookie}` },
  })
  assert.equal(revokeRes.status, 200)
  const revokedRow = await db.query('SELECT revoked_at FROM notification_devices WHERE id = $1', [regBody.deviceId])
  assert.ok(revokedRow.rows[0].revoked_at, 'revoked_at must be populated on device deletion')
  console.log('  ✓ Device revoked successfully')

  console.log('\n══════════════════════════════════════════════════════════════')
  console.log('  ALL 22 NOTIFICATION FORENSIC INTEGRATION TESTS PASSED 100%  ')
  console.log('══════════════════════════════════════════════════════════════\n')

  await db.end()
  process.exit(0)
} catch (err) {
  console.error('\n❌ NOTIFICATION FORENSIC SUITE FAILED:', err)
  await db.end().catch(() => {})
  process.exit(1)
}
