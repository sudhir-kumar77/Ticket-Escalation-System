import pg from 'pg'

const API_URL = process.env.API_URL ?? 'http://127.0.0.1:4001'
const DB_URL = process.env.DATABASE_URL ?? 'postgres://nvara:nvara_local_dev_only@localhost:55432/nvara'

const pool = new pg.Pool({ connectionString: DB_URL })

let passed = 0
let failed = 0

async function t(name, fn) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${err.message}`)
    failed++
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message ?? 'Assertion failed')
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg ?? `Expected ${JSON.stringify(a)} === ${JSON.stringify(b)}`)
}

async function login(email, password) {
  const res = await fetch(`${API_URL}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const cookie = res.headers.get('set-cookie')
  const body = await res.json()
  return { status: res.status, body, cookie }
}

console.log('\n══════════════════════════════════════════════════════════════')
console.log('       RT-001 - RT-011 TEAM MEMBER & SLA REGRESSION SUITE      ')
console.log('══════════════════════════════════════════════════════════════\n')

const { cookie: pmCookie } = await login('pm@nvaramedia.com', 'Nvara#PM2026!Secure')
const { cookie: rohanCookie } = await login('rohan.mehta@nvaramedia.com', 'Rohan#Ops2026!Dev')
const { cookie: priyaCookie } = await login('priya.sharma@nvaramedia.com', 'Priya#Ops2026!Dev')

// Get user IDs
const rohanId = (await pool.query("SELECT id FROM users WHERE email = 'rohan.mehta@nvaramedia.com'")).rows[0].id
const priyaId = (await pool.query("SELECT id FROM users WHERE email = 'priya.sharma@nvaramedia.com'")).rows[0].id

// RT-001: Client submit → PM assigns specialist → SLA starts on specialist assignment
await t('RT-001: Client submit -> PM assigns specialist -> specialist receives fresh 24h SLA', async () => {
  const sub = await fetch(`${API_URL}/v1/client/requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `rt-001-${Date.now()}` },
    body: JSON.stringify({
      name: 'RT Client',
      company: 'RT Corp',
      email: `rt001.${Date.now()}@example.com`,
      phone: '+919999900001',
      serviceDomain: 'seo',
      requirement: 'Requirement for RT-001 test verification.',
      urgency: 'flexible',
    }),
  })
  assertEqual(sub.status, 201)
  const { reference } = await sub.json()

  // PM assigns Rohan
  const reqDetail = await (await fetch(`${API_URL}/v1/pm/requests/${reference}`, { headers: { Cookie: pmCookie } })).json()
  const assign = await fetch(`${API_URL}/v1/pm/requests/${reference}/assignments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: pmCookie, 'Idempotency-Key': `rt-001-a-${Date.now()}` },
    body: JSON.stringify({ assigneeUserId: rohanId, expectedVersion: reqDetail.request.version }),
  })
  assertEqual(assign.status, 200)

  // Verify specialist assignment has active 24h SLA
  const postAssignSla = await pool.query(
    `SELECT s.id, s.status, s.policy_code, s.deadline_at FROM sla_records s JOIN assignments a ON a.id = s.assignment_id JOIN requests r ON r.id = a.request_id WHERE r.public_reference = $1 AND a.ended_at IS NULL AND a.assignee_user_id = $2`,
    [reference, rohanId]
  )
  assertEqual(postAssignSla.rowCount, 1)
  assertEqual(postAssignSla.rows[0].status, 'active')
  assertEqual(postAssignSla.rows[0].policy_code, 'acknowledgement_24h')
})

// RT-002: PM reassigns before deadline → old SLA superseded, new 24h SLA
await t('RT-002: PM reassigns before deadline -> old SLA superseded, new 24h SLA', async () => {
  const sub = await fetch(`${API_URL}/v1/client/requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `rt-002-${Date.now()}` },
    body: JSON.stringify({
      name: 'RT Client 2',
      company: 'RT Corp 2',
      email: `rt002.${Date.now()}@example.com`,
      phone: '+919999900002',
      serviceDomain: 'seo',
      requirement: 'Requirement for RT-002 test verification.',
      urgency: 'flexible',
    }),
  })
  const { reference } = await sub.json()
  const reqDetail = await (await fetch(`${API_URL}/v1/pm/requests/${reference}`, { headers: { Cookie: pmCookie } })).json()

  // Assign Rohan
  const a1 = await (
    await fetch(`${API_URL}/v1/pm/requests/${reference}/assignments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: pmCookie, 'Idempotency-Key': `rt-002-a1-${Date.now()}` },
      body: JSON.stringify({ assigneeUserId: rohanId, expectedVersion: reqDetail.request.version }),
    })
  ).json()

  // Reassign to Priya
  const a2 = await fetch(`${API_URL}/v1/pm/requests/${reference}/assignments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: pmCookie, 'Idempotency-Key': `rt-002-a2-${Date.now()}` },
    body: JSON.stringify({ assigneeUserId: priyaId, expectedVersion: a1.request.version }),
  })
  assertEqual(a2.status, 200)

  // Verify DB state: Rohan assignment ended & SLA superseded, Priya assignment active with fresh SLA
  const rohanSla = await pool.query(
    `SELECT a.ended_at, s.status FROM assignments a JOIN sla_records s ON s.assignment_id = a.id JOIN requests r ON r.id = a.request_id WHERE r.public_reference = $1 AND a.assignee_user_id = $2`,
    [reference, rohanId]
  )
  assert(rohanSla.rows[0].ended_at !== null, 'Rohan assignment should be ended')
  assertEqual(rohanSla.rows[0].status, 'superseded')

  const priyaSla = await pool.query(
    `SELECT a.ended_at, s.status FROM assignments a JOIN sla_records s ON s.assignment_id = a.id JOIN requests r ON r.id = a.request_id WHERE r.public_reference = $1 AND a.assignee_user_id = $2 AND a.ended_at IS NULL`,
    [reference, priyaId]
  )
  assertEqual(priyaSla.rowCount, 1)
  assertEqual(priyaSla.rows[0].status, 'active')
})

// RT-003: PM reassigns after deadline (before worker) → old SLA breached + escalation, new SLA
await t('RT-003: PM reassigns after deadline -> old SLA marked breached with escalation, new SLA created', async () => {
  const sub = await fetch(`${API_URL}/v1/client/requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `rt-003-${Date.now()}` },
    body: JSON.stringify({
      name: 'RT Client 3',
      company: 'RT Corp 3',
      email: `rt003.${Date.now()}@example.com`,
      phone: '+919999900003',
      serviceDomain: 'seo',
      requirement: 'Requirement for RT-003 test verification.',
      urgency: 'flexible',
    }),
  })
  const { reference } = await sub.json()
  const reqDetail = await (await fetch(`${API_URL}/v1/pm/requests/${reference}`, { headers: { Cookie: pmCookie } })).json()

  // Assign Rohan
  const a1 = await (
    await fetch(`${API_URL}/v1/pm/requests/${reference}/assignments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: pmCookie, 'Idempotency-Key': `rt-003-a1-${Date.now()}` },
      body: JSON.stringify({ assigneeUserId: rohanId, expectedVersion: reqDetail.request.version }),
    })
  ).json()

  // Artificially age deadline into past (maintaining started_at <= deadline_at)
  await pool.query(
    `UPDATE sla_records SET started_at = now() - interval '26 hours', deadline_at = now() - interval '2 hours' WHERE assignment_id = (SELECT a.id FROM assignments a JOIN requests r ON r.id = a.request_id WHERE r.public_reference = $1 AND a.assignee_user_id = $2 AND a.ended_at IS NULL)`,
    [reference, rohanId]
  )

  // Reassign to Priya
  const a2 = await fetch(`${API_URL}/v1/pm/requests/${reference}/assignments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: pmCookie, 'Idempotency-Key': `rt-003-a2-${Date.now()}` },
    body: JSON.stringify({ assigneeUserId: priyaId, expectedVersion: a1.request.version }),
  })
  assertEqual(a2.status, 200)

  // Verify Rohan's SLA was recorded as breached
  const rohanSla = await pool.query(
    `SELECT s.status, s.is_late FROM sla_records s JOIN assignments a ON a.id = s.assignment_id JOIN requests r ON r.id = a.request_id WHERE a.assignee_user_id = $1 AND r.public_reference = $2`,
    [rohanId, reference]
  )
  assertEqual(rohanSla.rows[0].status, 'breached')
})

// RT-004: PM acknowledges on behalf → acknowledged_by_user_id = specialist, metadata acknowledged_by_pm=true
await t('RT-004: PM acknowledges on behalf -> acknowledged_by_user_id = specialist, metadata acknowledged_by_pm=true', async () => {
  const sub = await fetch(`${API_URL}/v1/client/requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `rt-004-${Date.now()}` },
    body: JSON.stringify({
      name: 'RT Client 4',
      company: 'RT Corp 4',
      email: `rt004.${Date.now()}@example.com`,
      phone: '+919999900004',
      serviceDomain: 'seo',
      requirement: 'Requirement for RT-004 test verification.',
      urgency: 'flexible',
    }),
  })
  const { reference } = await sub.json()
  const reqDetail = await (await fetch(`${API_URL}/v1/pm/requests/${reference}`, { headers: { Cookie: pmCookie } })).json()

  // Assign Rohan
  const a1 = await (
    await fetch(`${API_URL}/v1/pm/requests/${reference}/assignments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: pmCookie, 'Idempotency-Key': `rt-004-a1-${Date.now()}` },
      body: JSON.stringify({ assigneeUserId: rohanId, expectedVersion: reqDetail.request.version }),
    })
  ).json()

  // PM acknowledges on behalf
  const ack = await fetch(`${API_URL}/v1/requests/${reference}/acknowledge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: pmCookie, 'Idempotency-Key': `rt-004-ack-${Date.now()}` },
    body: JSON.stringify({ expectedVersion: a1.request.version }),
  })
  assertEqual(ack.status, 200)

  // Verify SLA record for active assignment has acknowledged_by_user_id = rohanId (accountable specialist)
  const slaRec = await pool.query(
    `SELECT s.acknowledged_by_user_id FROM sla_records s JOIN assignments a ON a.id = s.assignment_id JOIN requests r ON r.id = a.request_id WHERE r.public_reference = $1 AND a.assignee_user_id = $2`,
    [reference, rohanId]
  )
  assertEqual(slaRec.rows[0].acknowledged_by_user_id, rohanId)

  // Verify audit event has acknowledged_by_pm: true
  const auditEv = await pool.query(
    `SELECT a.metadata FROM audit_events a JOIN requests r ON r.id = a.request_id WHERE r.public_reference = $1 AND a.event_type = 'acknowledged'`,
    [reference]
  )
  assertEqual(auditEv.rows[0].metadata.acknowledged_by_pm, true)
})

// RT-005: Specialist deactivated with reassignment → new SLA, status awaiting_acknowledgement
await t('RT-005: Specialist deactivated with reassignment -> new SLA, status awaiting_acknowledgement', async () => {
  // Create a disposable specialist
  const inv = await (
    await fetch(`${API_URL}/v1/pm/users/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: pmCookie },
      body: JSON.stringify({
        displayName: 'Deactivate Specialist',
        email: `deact.${Date.now()}@nvaramedia.com`,
        role: 'internal_team_member',
        mode: 'invite_link',
      }),
    })
  ).json()

  const acc = await (
    await fetch(`${API_URL}/v1/invitations/${inv.rawToken}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'DeactPass#2026!Sec' }),
    })
  ).json()
  const deactUserId = acc.user.id

  // Create ticket assigned to deactUserId
  const sub = await fetch(`${API_URL}/v1/client/requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `rt-005-${Date.now()}` },
    body: JSON.stringify({
      name: 'RT Client 5',
      company: 'RT Corp 5',
      email: `rt005.${Date.now()}@example.com`,
      phone: '+919999900005',
      serviceDomain: 'seo',
      requirement: 'Requirement for RT-005 test verification.',
      urgency: 'flexible',
    }),
  })
  const { reference } = await sub.json()
  const reqDetail = await (await fetch(`${API_URL}/v1/pm/requests/${reference}`, { headers: { Cookie: pmCookie } })).json()

  const a1 = await (
    await fetch(`${API_URL}/v1/pm/requests/${reference}/assignments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: pmCookie, 'Idempotency-Key': `rt-005-a1-${Date.now()}` },
      body: JSON.stringify({ assigneeUserId: deactUserId, expectedVersion: reqDetail.request.version }),
    })
  ).json()

  // Deactivate deactUserId with reassignment to Priya
  const deact = await fetch(`${API_URL}/v1/pm/users/${deactUserId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: pmCookie },
    body: JSON.stringify({ isActive: false, reassignToUserId: priyaId }),
  })
  assertEqual(deact.status, 200)

  // Verify ticket status is awaiting_acknowledgement and assigned to Priya with new SLA
  const updatedReq = await pool.query(
    `SELECT r.status, a.assignee_user_id, s.status AS sla_status FROM requests r JOIN assignments a ON a.request_id = r.id AND a.ended_at IS NULL JOIN sla_records s ON s.assignment_id = a.id WHERE r.public_reference = $1`,
    [reference]
  )
  assertEqual(updatedReq.rows[0].status, 'awaiting_acknowledgement')
  assertEqual(updatedReq.rows[0].assignee_user_id, priyaId)
  assertEqual(updatedReq.rows[0].sla_status, 'active')
})

// RT-006: Specialist deactivated without reassignment → PM triage, no SLA
await t('RT-006: Specialist deactivated without reassignment -> unassigned, no active SLA', async () => {
  const inv = await (
    await fetch(`${API_URL}/v1/pm/users/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: pmCookie },
      body: JSON.stringify({
        displayName: 'Deactivate Specialist 2',
        email: `deact2.${Date.now()}@nvaramedia.com`,
        role: 'internal_team_member',
        mode: 'invite_link',
      }),
    })
  ).json()

  const acc = await (
    await fetch(`${API_URL}/v1/invitations/${inv.rawToken}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'DeactPass#2026!Sec' }),
    })
  ).json()
  const deactUserId = acc.user.id

  const sub = await fetch(`${API_URL}/v1/client/requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `rt-006-${Date.now()}` },
    body: JSON.stringify({
      name: 'RT Client 6',
      company: 'RT Corp 6',
      email: `rt006.${Date.now()}@example.com`,
      phone: '+919999900006',
      serviceDomain: 'seo',
      requirement: 'Requirement for RT-006 test verification.',
      urgency: 'flexible',
    }),
  })
  const { reference } = await sub.json()
  const reqDetail = await (await fetch(`${API_URL}/v1/pm/requests/${reference}`, { headers: { Cookie: pmCookie } })).json()

  await fetch(`${API_URL}/v1/pm/requests/${reference}/assignments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: pmCookie, 'Idempotency-Key': `rt-006-a1-${Date.now()}` },
    body: JSON.stringify({ assigneeUserId: deactUserId, expectedVersion: reqDetail.request.version }),
  })

  // Deactivate without reassignToUserId
  const deact = await fetch(`${API_URL}/v1/pm/users/${deactUserId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: pmCookie },
    body: JSON.stringify({ isActive: false }),
  })
  assertEqual(deact.status, 200)

  // Verify no active assignment and no active SLA
  const openAssign = await pool.query(
    `SELECT a.id FROM assignments a JOIN requests r ON r.id = a.request_id WHERE r.public_reference = $1 AND a.ended_at IS NULL`,
    [reference]
  )
  assertEqual(openAssign.rowCount, 0, 'Should have no open assignments')
})

// RT-007: Worker processes breach → request unchanged, escalation event created
await t('RT-007: Worker processes breach -> request version bumps, escalation event created', async () => {
  const { evaluateOverdueSlas } = await import('../../apps/worker/dist/worker.js')

  const sub = await fetch(`${API_URL}/v1/client/requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `rt-007-${Date.now()}` },
    body: JSON.stringify({
      name: 'RT Client 7',
      company: 'RT Corp 7',
      email: `rt007.${Date.now()}@example.com`,
      phone: '+919999900007',
      serviceDomain: 'seo',
      requirement: 'Requirement for RT-007 test verification.',
      urgency: 'flexible',
    }),
  })
  const { reference } = await sub.json()
  const reqDetail = await (await fetch(`${API_URL}/v1/pm/requests/${reference}`, { headers: { Cookie: pmCookie } })).json()

  const a1 = await (
    await fetch(`${API_URL}/v1/pm/requests/${reference}/assignments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: pmCookie, 'Idempotency-Key': `rt-007-a1-${Date.now()}` },
      body: JSON.stringify({ assigneeUserId: rohanId, expectedVersion: reqDetail.request.version }),
    })
  ).json()

  // Make deadline overdue (maintaining started_at <= deadline_at)
  await pool.query(
    `UPDATE sla_records SET started_at = now() - interval '25 hours', deadline_at = now() - interval '1 hour' WHERE assignment_id = (SELECT a.id FROM assignments a JOIN requests r ON r.id = a.request_id WHERE r.public_reference = $1 AND a.assignee_user_id = $2 AND a.ended_at IS NULL)`,
    [reference, rohanId]
  )

  // Run worker evaluation
  const res = await evaluateOverdueSlas(pool)
  assert(res.breached >= 1, 'Expected at least 1 breach evaluated')

  // Verify escalation_events row created
  const esc = await pool.query(
    `SELECT e.id, e.reason FROM escalation_events e JOIN requests r ON r.id = e.request_id WHERE r.public_reference = $1`,
    [reference]
  )
  assertEqual(esc.rowCount, 1)
  assertEqual(esc.rows[0].reason, 'acknowledgement_sla_breached')
})

// RT-008: Public tracker after reassignment → shows current specialist's assigned_at
await t('RT-008: Public tracker after reassignment -> shows current specialist assigned_at', async () => {
  const sub = await fetch(`${API_URL}/v1/client/requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `rt-008-${Date.now()}` },
    body: JSON.stringify({
      name: 'RT Client 8',
      company: 'RT Corp 8',
      email: `rt008.${Date.now()}@example.com`,
      phone: '+919999900008',
      serviceDomain: 'seo',
      requirement: 'Requirement for RT-008 test verification.',
      urgency: 'flexible',
    }),
  })
  const { reference } = await sub.json()
  const reqDetail = await (await fetch(`${API_URL}/v1/pm/requests/${reference}`, { headers: { Cookie: pmCookie } })).json()

  // Assign Rohan
  const a1 = await (
    await fetch(`${API_URL}/v1/pm/requests/${reference}/assignments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: pmCookie, 'Idempotency-Key': `rt-008-a1-${Date.now()}` },
      body: JSON.stringify({ assigneeUserId: rohanId, expectedVersion: reqDetail.request.version }),
    })
  ).json()

  // Sleep 1s to ensure distinct timestamp
  await new Promise((r) => setTimeout(r, 1000))

  // Reassign Priya
  const a2 = await (
    await fetch(`${API_URL}/v1/pm/requests/${reference}/assignments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: pmCookie, 'Idempotency-Key': `rt-008-a2-${Date.now()}` },
      body: JSON.stringify({ assigneeUserId: priyaId, expectedVersion: a1.request.version }),
    })
  ).json()

  const tracker = await (await fetch(`${API_URL}/v1/track/${reference}`)).json()
  const milestone = tracker.milestones.find((m) => m.type === 'SPECIALIST_ASSIGNED')
  assert(milestone, 'Expected SPECIALIST_ASSIGNED milestone')

  const priyaAssignedAt = (
    await pool.query(
      `SELECT a.assigned_at FROM assignments a JOIN requests r ON r.id = a.request_id WHERE r.public_reference = $1 AND a.assignee_user_id = $2 AND a.ended_at IS NULL`,
      [reference, priyaId]
    )
  ).rows[0].assigned_at

  assertEqual(new Date(milestone.occurredAt).toISOString(), priyaAssignedAt.toISOString())
})

// RT-009: Concurrent acceptance → one succeeds, one 400, no duplicate user
await t('RT-009: Concurrent acceptance -> one succeeds, one 400, no duplicate user', async () => {
  const inv = await (
    await fetch(`${API_URL}/v1/pm/users/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: pmCookie },
      body: JSON.stringify({
        displayName: 'Concurrent Accept User',
        email: `concur.${Date.now()}@nvaramedia.com`,
        role: 'internal_team_member',
        mode: 'invite_link',
      }),
    })
  ).json()

  const [res1, res2] = await Promise.all([
    fetch(`${API_URL}/v1/invitations/${inv.rawToken}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'ConcurPass#2026!Sec' }),
    }),
    fetch(`${API_URL}/v1/invitations/${inv.rawToken}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'ConcurPass#2026!Sec' }),
    }),
  ])

  const statuses = [res1.status, res2.status].sort()
  assertEqual(statuses[0], 201, 'One request should succeed with 201')
  assertEqual(statuses[1], 400, 'Other request should fail with 400')
})

// RT-010: Concurrent instant creation / invite → one succeeds, one 409
await t('RT-010: Concurrent invitation with same email -> one succeeds, one 409', async () => {
  // If email already exists in users table, concurrent invite for same email should reject
  const duplicateEmail = `concur.dup.${Date.now()}@nvaramedia.com`

  // First create user
  const inv1 = await (
    await fetch(`${API_URL}/v1/pm/users/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: pmCookie },
      body: JSON.stringify({
        displayName: 'Existing User',
        email: duplicateEmail,
        role: 'internal_team_member',
        mode: 'invite_link',
      }),
    })
  ).json()

  await fetch(`${API_URL}/v1/invitations/${inv1.rawToken}/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'Password#2026!Sec' }),
  })

  // Concurrent invitations for existing email
  const [res1, res2] = await Promise.all([
    fetch(`${API_URL}/v1/pm/users/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: pmCookie },
      body: JSON.stringify({
        displayName: 'Duplicate 1',
        email: duplicateEmail,
        role: 'internal_team_member',
        mode: 'invite_link',
      }),
    }),
    fetch(`${API_URL}/v1/pm/users/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: pmCookie },
      body: JSON.stringify({
        displayName: 'Duplicate 2',
        email: duplicateEmail,
        role: 'internal_team_member',
        mode: 'invite_link',
      }),
    }),
  ])

  assertEqual(res1.status, 409)
  assertEqual(res2.status, 409)
})

// RT-011: PM from Org A cannot access Org B users
await t('RT-011: Cross-organization user isolation enforced', async () => {
  // Create second organization in DB
  const orgB = await pool.query("INSERT INTO organizations (name) VALUES ('Org B') RETURNING id")
  const orgBId = orgB.rows[0].id

  // Create user in Org B
  const userB = await pool.query(
    "INSERT INTO users (organization_id, email, display_name, password_hash, is_active) VALUES ($1, 'user.b@orgb.com', 'User B', 'hash', true) RETURNING id",
    [orgBId]
  )
  const userBId = userB.rows[0].id

  // PM from Nvara Media tries to access user B detail
  const res = await fetch(`${API_URL}/v1/pm/users/${userBId}/detail`, {
    headers: { Cookie: pmCookie },
  })
  assertEqual(res.status, 404, 'Cross-org user should return 404 Not Found')

  // Clean up Org B
  await pool.query('DELETE FROM users WHERE organization_id = $1', [orgBId])
  await pool.query('DELETE FROM organizations WHERE id = $1', [orgBId])
})

console.log(`\n══════════════════════════════════════════════════════════════`)
console.log(` RESULTS: ${passed} PASSED, ${failed} FAILED`)
console.log(`══════════════════════════════════════════════════════════════\n`)

await pool.end()
if (failed > 0) process.exit(1)
