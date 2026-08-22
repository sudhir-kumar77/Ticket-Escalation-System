import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

const API_URL = process.env.API_URL ?? 'http://127.0.0.1:4001'
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://nvara:nvara_local_dev_only@localhost:55432/nvara'
const db = new pg.Pool({ connectionString: DATABASE_URL })

console.log('\n══════════════════════════════════════════════════════════════')
console.log('  PHASE 19 — COMPLETE E2E USER JOURNEY FORENSIC SUITE         ')
console.log('══════════════════════════════════════════════════════════════\n')

try {
  // Helper for logging in and getting cookie
  async function login(email, password) {
    const res = await fetch(`${API_URL}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    assert.equal(res.status, 200, `Login failed for ${email}`)
    const setCookie = res.headers.get('set-cookie')
    assert.ok(setCookie, 'Set-Cookie header missing')
    const cookie = setCookie.split(';')[0]
    const body = await res.json()
    return { cookie, user: body.user }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // JOURNEY A: Full Client -> PM -> Specialist Workflow & Resolution (J1 - J7)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('▶ Journey A: Full Workflow Lifecycle (Submit -> Assign -> Ack -> Start -> Resolve -> Archive)')
  
  // 1. Client Submits Request (J1)
  const intakeRes = await fetch(`${API_URL}/v1/client/requests`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `e2e_intake_${randomUUID()}`,
    },
    body: JSON.stringify({
      name: 'Ananya Roy',
      company: 'Apex Design Labs',
      email: `ananya_${randomUUID().slice(0, 6)}@apexlabs.in`,
      phone: '+919876543210',
      serviceDomain: 'seo',
      requirement: 'Full Technical SEO Architecture and Core Web Vitals Audit.',
      urgency: 'time_sensitive',
    }),
  })
  assert.equal(intakeRes.status, 201)
  const intakeData = await intakeRes.json()
  const reqRef = intakeData.reference
  assert.ok(reqRef.startsWith('NVARA-2026-'))

  // 2. PM Logs in and Inspects Queue (J2)
  const pmAuth = await login('pm@nvaramedia.com', 'Nvara#PM2026!Secure')
  const queueRes = await fetch(`${API_URL}/v1/pm/requests`, {
    headers: { Cookie: pmAuth.cookie },
  })
  assert.equal(queueRes.status, 200)
  const queueData = await queueRes.json()
  const ticketSummary = queueData.requests.find(r => r.reference === reqRef)
  assert.ok(ticketSummary, 'Newly submitted request must appear in PM Queue')
  assert.equal(ticketSummary.status, 'awaiting_acknowledgement')

  // 3. PM Assigns Specialist Rohan Mehta (J3)
  const rohanUserId = (await db.query("SELECT id FROM users WHERE email = 'rohan.mehta@nvaramedia.com'")).rows[0].id
  const assignRes = await fetch(`${API_URL}/v1/pm/requests/${reqRef}/assignments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: pmAuth.cookie,
      'Idempotency-Key': `e2e_assign_${randomUUID()}`,
    },
    body: JSON.stringify({
      assigneeUserId: rohanUserId,
      expectedVersion: ticketSummary.version,
    }),
  })
  assert.equal(assignRes.status, 200)
  const assignData = await assignRes.json()
  assert.equal(assignData.request.status, 'awaiting_acknowledgement')
  assert.equal(assignData.request.version, ticketSummary.version + 1)
  console.log('  ✓ [J1-J3] Client intake and PM assignment executed with version bump')

  // 4. Specialist Rohan Logs in and Acknowledges Ticket (J4)
  const rohanAuth = await login('rohan.mehta@nvaramedia.com', 'Rohan#Ops2026!Dev')
  const ackRes = await fetch(`${API_URL}/v1/requests/${reqRef}/acknowledge`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: rohanAuth.cookie,
      'Idempotency-Key': `e2e_ack_${randomUUID()}`,
    },
    body: JSON.stringify({ expectedVersion: assignData.request.version }),
  })
  assert.equal(ackRes.status, 200)
  const ackData = await ackRes.json()
  assert.equal(ackData.request.status, 'acknowledged')

  // 5. Specialist Starts Work (J5)
  const startRes = await fetch(`${API_URL}/v1/requests/${reqRef}/start-work`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: rohanAuth.cookie,
      'Idempotency-Key': `e2e_start_${randomUUID()}`,
    },
    body: JSON.stringify({ expectedVersion: ackData.request.version }),
  })
  assert.equal(startRes.status, 200)
  const startData = await startRes.json()
  assert.equal(startData.request.status, 'in_progress')

  // 6. Specialist Resolves Ticket (J6)
  const resolveRes = await fetch(`${API_URL}/v1/requests/${reqRef}/resolve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: rohanAuth.cookie,
      'Idempotency-Key': `e2e_resolve_${randomUUID()}`,
    },
    body: JSON.stringify({ expectedVersion: startData.request.version }),
  })
  assert.equal(resolveRes.status, 200)
  const resolveData = await resolveRes.json()
  assert.equal(resolveData.request.status, 'resolved')

  // 7. Public Tracker shows COMPLETED milestone (J30-J34)
  const trackerRes = await fetch(`${API_URL}/v1/track/${reqRef}`)
  assert.equal(trackerRes.status, 200)
  const trackerData = await trackerRes.json()
  assert.equal(trackerData.status, 'COMPLETED')
  assert.equal(trackerData.milestones.every(m => m.completed), true)

  // 8. PM Soft-Deletes / Archives the Resolved Ticket (J7, J35)
  const deleteRes = await fetch(`${API_URL}/v1/pm/requests/${reqRef}`, {
    method: 'DELETE',
    headers: { Cookie: pmAuth.cookie },
  })
  assert.equal(deleteRes.status, 200)

  // Public tracker returns 404 on archived requests (privacy invariant J35)
  const archivedTrackerRes = await fetch(`${API_URL}/v1/track/${reqRef}`)
  assert.equal(archivedTrackerRes.status, 404)
  console.log('  ✓ [J4-J7, J30-J35] Specialist workflow, completion, and privacy-preserving archive verified')

  // ─────────────────────────────────────────────────────────────────────────────
  // JOURNEY B: Invitation -> Onboarding -> Workspace Entry (J8 - J13)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n▶ Journey B: Invitation -> Onboarding -> Login -> Assignment (J8 - J13)')
  const newSpecEmail = `invitee_${randomUUID().slice(0, 6)}@nvaramedia.com`
  const inviteRes = await fetch(`${API_URL}/v1/pm/users/invite`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: pmAuth.cookie,
      'Idempotency-Key': `e2e_invite_${randomUUID()}`,
    },
    body: JSON.stringify({
      displayName: 'Karan Mehra',
      email: newSpecEmail,
      role: 'internal_team_member',
    }),
  })
  assert.equal(inviteRes.status, 201)
  const inviteData = await inviteRes.json()
  assert.ok(inviteData.rawToken)

  // Invitee accepts invitation and creates password
  const newPassword = 'NewSpecialist#2026!Pass'
  const acceptRes = await fetch(`${API_URL}/v1/invitations/${encodeURIComponent(inviteData.rawToken)}/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      password: newPassword,
    }),
  })
  assert.equal(acceptRes.status, 201)
  const acceptData = await acceptRes.json()
  assert.equal(acceptData.user.email, newSpecEmail)
  assert.equal(acceptData.user.role, 'internal_team_member')

  // Invitee logs in and verifies active profile
  const newSpecAuth = await login(newSpecEmail, newPassword)
  assert.equal(newSpecAuth.user.displayName, 'Karan Mehra')
  console.log('  ✓ [J8-J13] Seamless team member invitation, password creation, and workspace login verified')

  // ─────────────────────────────────────────────────────────────────────────────
  // JOURNEY C: Deactivation & Workload Rebalancing (J17 - J20)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n▶ Journey C: Specialist Deactivation & Instant Reallocation (J17 - J20)')
  // Create a ticket assigned to newly onboarded specialist Karan
  const karanUserId = acceptData.user.id
  const deactReqRef = `NVARA-2026-${randomUUID().slice(0, 8).toUpperCase()}`
  const orgId = (await db.query("SELECT organization_id FROM users WHERE email = 'pm@nvaramedia.com'")).rows[0].organization_id
  const clientId = (await db.query('SELECT id FROM clients WHERE organization_id = $1 LIMIT 1', [orgId])).rows[0].id
  const sdId = (await db.query('SELECT id FROM service_domains LIMIT 1')).rows[0].id

  const deactReqId = randomUUID()
  await db.query(
    `INSERT INTO requests (id, organization_id, public_reference, client_id, service_domain_id, requirement, urgency)
     VALUES ($1, $2, $3, $4, $5, 'Deactivation Test Requirement', 'flexible')`,
    [deactReqId, orgId, deactReqRef, clientId, sdId]
  )
  await db.query(
    `INSERT INTO assignments (request_id, assignee_user_id, assigned_by_user_id)
     VALUES ($1, $2, $3)`,
    [deactReqId, karanUserId, pmAuth.user.id]
  )

  // PM deactivates Karan Mehra with fallback reassign to Rohan Mehta
  const deactRes = await fetch(`${API_URL}/v1/pm/users/${karanUserId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Cookie: pmAuth.cookie,
      'Idempotency-Key': `e2e_deact_${randomUUID()}`,
    },
    body: JSON.stringify({ isActive: false, reassignToUserId: rohanUserId }),
  })
  assert.equal(deactRes.status, 200)

  // Karan's active session is instantly revoked
  const karanActionRes = await fetch(`${API_URL}/v1/requests/${deactReqRef}/acknowledge`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: newSpecAuth.cookie,
    },
    body: JSON.stringify({ expectedVersion: 1 }),
  })
  assert.equal(karanActionRes.status, 401, 'Deactivated user session must be revoked immediately')

  // Request assignment moved cleanly to Rohan Mehta
  const reallocatedAssign = await db.query(
    `SELECT assignee_user_id FROM assignments WHERE request_id = $1 AND ended_at IS NULL`,
    [deactReqId]
  )
  assert.equal(reallocatedAssign.rows[0].assignee_user_id, rohanUserId)
  console.log('  ✓ [J17-J20] Deactivation revokes session instantly and rebalances workload to active specialist')

  // ─────────────────────────────────────────────────────────────────────────────
  // JOURNEY D: PM Operational Override & Audit Attribution (J27 - J29)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n▶ Journey D: PM Operational Override & Audit Attribution (J27 - J29)')
  // PM acknowledges on behalf of specialist Rohan
  const overrideAckRes = await fetch(`${API_URL}/v1/requests/${deactReqRef}/acknowledge`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: pmAuth.cookie,
      'Idempotency-Key': `e2e_override_${randomUUID()}`,
    },
    body: JSON.stringify({ expectedVersion: 2 }),
  })
  assert.equal(overrideAckRes.status, 200)

  // Verify audit event captures override: true and PM actor
  const auditRes = await db.query(
    `SELECT actor_user_id, metadata FROM audit_events WHERE request_id = $1 AND event_type = 'acknowledged' ORDER BY occurred_at DESC LIMIT 1`,
    [deactReqId]
  )
  assert.equal(auditRes.rows[0].actor_user_id, pmAuth.user.id)
  const meta = auditRes.rows[0].metadata
  assert.equal(meta.override, true)
  assert.equal(meta.originalAssigneeUserId, rohanUserId)
  console.log('  ✓ [J27-J29] PM administrative override accurately attributes PM actor while preserving specialist accountability')

  console.log('\n══════════════════════════════════════════════════════════════')
  console.log(' RESULTS: ALL E2E USER JOURNEY TESTS PASSED 🎉                ')
  console.log('══════════════════════════════════════════════════════════════\n')
} finally {
  await db.end()
}
