import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

const API_ORIGIN = process.env.API_ORIGIN ?? process.env.API_URL ?? 'http://127.0.0.1:4001'
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://nvara:nvara_local_dev_only@localhost:55432/nvara'
const db = new pg.Pool({ connectionString: DATABASE_URL })

console.log('\n══════════════════════════════════════════════════════════════')
console.log('   FAANG-GRADE USER, TEAM & IDENTITY LIFECYCLE TEST SUITE    ')
console.log('══════════════════════════════════════════════════════════════\n')

try {
  // Login PM
  const pmRes = await fetch(`${API_ORIGIN}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'pm@nvaramedia.com', password: 'Nvara#PM2026!Secure' }),
  })
  assert.equal(pmRes.status, 200)
  const pmCookie = pmRes.headers.get('set-cookie')?.split(';')[0] || ''

  // 1. Complete Invitation -> Acceptance -> Active Lifecycle
  console.log('1. Invitation -> Onboarding -> Active Account Lifecycle')
  const newEmail = `lifecycle.${randomUUID().slice(0, 6)}@nvaramedia.com`
  const inviteRes = await fetch(`${API_ORIGIN}/v1/pm/users/invite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: pmCookie },
    body: JSON.stringify({
      displayName: 'Devika Nair',
      email: newEmail,
      role: 'internal_team_member',
      mode: 'invite_link',
    }),
  })
  assert.equal(inviteRes.status, 201)
  const inviteData = await inviteRes.json()
  const rawToken = inviteData.inviteUrl.split('?invite=')[1]
  assert.ok(rawToken)

  // Verify public invite verification endpoint
  const verifyRes = await fetch(`${API_ORIGIN}/v1/invitations/${rawToken}`)
  assert.equal(verifyRes.status, 200)
  const verifyData = await verifyRes.json()
  assert.equal(verifyData.email, newEmail)
  assert.equal(verifyData.role, 'internal_team_member')

  // Accept invitation and onboard
  const acceptRes = await fetch(`${API_ORIGIN}/v1/invitations/${rawToken}/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      password: 'Devika#Password2026!',
    }),
  })
  assert.equal(acceptRes.status, 201)
  const devikaCookie = acceptRes.headers.get('set-cookie')?.split(';')[0] || ''
  assert.ok(devikaCookie)

  // Verify Devika is now active in DB with exactly 1 role
  const devikaDb = await db.query(
    `SELECT u.id, u.is_active, r.code AS role
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     WHERE u.email = $1`,
    [newEmail]
  )
  assert.equal(devikaDb.rowCount, 1)
  assert.equal(devikaDb.rows[0].is_active, true)
  assert.equal(devikaDb.rows[0].role, 'internal_team_member')
  const devikaId = devikaDb.rows[0].id
  console.log('  ✓ Devika successfully invited, onboarded, and assigned single role')

  // 2. Duplicate Acceptance Replay Protection
  console.log('\n2. Replay Protection on Accepted Invitation')
  const reAcceptRes = await fetch(`${API_ORIGIN}/v1/invitations/${rawToken}/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      password: 'Another#Password123!',
    }),
  })
  assert.equal(reAcceptRes.status, 400)
  console.log('  ✓ Replaying used invitation token strictly fails with 400')

  // 3. Duplicate Email Protection within Organization
  console.log('\n3. Duplicate Email Conflict Protection')
  const dupInviteRes = await fetch(`${API_ORIGIN}/v1/pm/users/invite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: pmCookie },
    body: JSON.stringify({
      displayName: 'Devika Clone',
      email: newEmail,
      role: 'internal_team_member',
    }),
  })
  assert.equal(dupInviteRes.status, 409)
  console.log('  ✓ Attempting to invite existing active email returns 409 Conflict')

  // 4. Role Promotion / Demotion Lifecycle
  console.log('\n4. Role Promotion & Mutation Lifecycle')
  const promoteRes = await fetch(`${API_ORIGIN}/v1/pm/users/${devikaId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: pmCookie },
    body: JSON.stringify({
      role: 'project_manager',
    }),
  })
  assert.equal(promoteRes.status, 200)

  // Verify role updated atomically in DB
  const roleCheck = await db.query(
    'SELECT count(*)::int AS count, min(r.code) AS role FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1',
    [devikaId]
  )
  assert.equal(roleCheck.rows[0].count, 1, 'User must have exactly 1 role')
  assert.equal(roleCheck.rows[0].role, 'project_manager')
  console.log('  ✓ Devika successfully promoted to project_manager (Exactly 1 role invariant maintained)')

  // 5. Deactivation, Session Invalidation & Workload Rebalancing
  console.log('\n5. Deactivation & Workload Rebalancing')
  // Demote back to specialist and assign ticket
  await fetch(`${API_ORIGIN}/v1/pm/users/${devikaId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: pmCookie },
    body: JSON.stringify({ role: 'internal_team_member' }),
  })

  // Create ticket and assign to Devika
  const reqRes = await fetch(`${API_ORIGIN}/v1/client/requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `devika-req-${randomUUID()}` },
    body: JSON.stringify({
      name: 'Client D',
      company: 'Devika Corp',
      email: `client.${randomUUID().slice(0, 6)}@devika.test`,
      phone: '+919876533333',
      serviceDomain: 'seo',
      requirement: 'Devika assignment before deactivation test.',
      urgency: 'soon',
    }),
  })
  const ref = (await reqRes.json()).reference

  await fetch(`${API_ORIGIN}/v1/pm/requests/${ref}/assignments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: pmCookie, 'Idempotency-Key': `assign-d-${randomUUID()}` },
    body: JSON.stringify({ expectedVersion: 1, assigneeUserId: devikaId }),
  })

  // Deactivate Devika
  const deactRes = await fetch(`${API_ORIGIN}/v1/pm/users/${devikaId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: pmCookie },
    body: JSON.stringify({ isActive: false }),
  })
  assert.equal(deactRes.status, 200)

  // Verify Devika session is revoked
  const authMeRes = await fetch(`${API_ORIGIN}/v1/auth/me`, {
    headers: { Cookie: devikaCookie },
  })
  assert.equal(authMeRes.status, 401)

  // Verify ticket returned to triage queue and SLA superseded
  const ticketCheck = await db.query(
    `SELECT req.status, a.ended_at, s.status AS sla_status
     FROM requests req
     JOIN assignments a ON a.request_id = req.id
     JOIN sla_records s ON s.assignment_id = a.id
     WHERE req.public_reference = $1 AND a.assignee_user_id = $2`,
    [ref, devikaId]
  )
  assert.equal(ticketCheck.rows[0].status, 'awaiting_acknowledgement')
  assert.ok(ticketCheck.rows[0].ended_at !== null)
  assert.equal(ticketCheck.rows[0].sla_status, 'superseded')
  console.log('  ✓ Deactivation terminates active sessions, ends assignments, and supersedes SLAs')

  // 6. Safe Reactivation
  console.log('\n6. Safe Reactivation Lifecycle')
  const reactRes = await fetch(`${API_ORIGIN}/v1/pm/users/${devikaId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: pmCookie },
    body: JSON.stringify({ isActive: true }),
  })
  assert.equal(reactRes.status, 200)

  // Verify Devika can log in fresh
  const loginRes = await fetch(`${API_ORIGIN}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: newEmail, password: 'Devika#Password2026!' }),
  })
  assert.equal(loginRes.status, 200)

  // Verify previous terminated assignment was NOT resurrected
  const activeAssignments = await db.query(
    'SELECT count(*)::int AS count FROM assignments WHERE assignee_user_id = $1 AND ended_at IS NULL',
    [devikaId]
  )
  assert.equal(activeAssignments.rows[0].count, 0, 'Reactivated user must have 0 active assignments')
  console.log('  ✓ Reactivation restores login ability without resurrecting terminated assignments')

  console.log('\n══════════════════════════════════════════════════════════════')
  console.log(' RESULTS: ALL USER & TEAM LIFECYCLE TESTS PASSED 🎉           ')
  console.log('══════════════════════════════════════════════════════════════\n')
} finally {
  await db.end()
}
