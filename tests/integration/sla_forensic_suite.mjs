import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

const API_ORIGIN = process.env.API_ORIGIN ?? process.env.API_URL ?? 'http://127.0.0.1:4001'
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://nvara:nvara_local_dev_only@localhost:55432/nvara'
const db = new pg.Pool({ connectionString: DATABASE_URL })

console.log('\n══════════════════════════════════════════════════════════════')
console.log('       FAANG-GRADE SLA, BREACH & ESCALATION TEST SUITE        ')
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

  // Login Specialist Rohan
  const rohanRes = await fetch(`${API_ORIGIN}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'rohan.mehta@nvaramedia.com', password: 'Rohan#Ops2026!Dev' }),
  })
  assert.equal(rohanRes.status, 200)
  const rohanCookie = rohanRes.headers.get('set-cookie')?.split(';')[0] || ''

  // Login Specialist Priya
  const priyaRes = await fetch(`${API_ORIGIN}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'priya.sharma@nvaramedia.com', password: 'Priya#Ops2026!Dev' }),
  })
  assert.equal(priyaRes.status, 200)
  const priyaCookie = priyaRes.headers.get('set-cookie')?.split(';')[0] || ''

  const rohanUser = (await db.query("SELECT id FROM users WHERE email = 'rohan.mehta@nvaramedia.com'")).rows[0]
  const priyaUser = (await db.query("SELECT id FROM users WHERE email = 'priya.sharma@nvaramedia.com'")).rows[0]

  // 1. Intake SLA Isolation (No Specialist SLA at intake)
  console.log('1. Intake Triage SLA Isolation')
  const reqRes = await fetch(`${API_ORIGIN}/v1/client/requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `sla-intake-${randomUUID()}` },
    body: JSON.stringify({
      name: 'SLA Test Client',
      company: 'SLA Analytics Co',
      email: `sla.${randomUUID().slice(0, 6)}@analytics.test`,
      phone: '+919876500000',
      serviceDomain: 'seo',
      requirement: 'Verify exact SLA creation and deadline calculation.',
      urgency: 'soon',
    }),
  })
  assert.equal(reqRes.status, 201)
  const { reference } = await reqRes.json()

  // Verify no SLA record exists in DB for this request
  const slaCheck1 = await db.query(
    'SELECT s.id FROM sla_records s JOIN assignments a ON a.id = s.assignment_id JOIN requests r ON r.id = a.request_id WHERE r.public_reference = $1',
    [reference]
  )
  assert.equal(slaCheck1.rowCount, 0, 'Intake assignment must have zero specialist SLA records')
  console.log('  ✓ Client intake assignment has zero SLA records (Triage Isolation Invariant)')

  // 2. SLA Creation on Specialist Assignment (Exactly 24 Hours)
  console.log('\n2. Specialist SLA Creation & Exact 24h Duration')
  const assignRes = await fetch(`${API_ORIGIN}/v1/pm/requests/${reference}/assignments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: pmCookie, 'Idempotency-Key': `assign-${randomUUID()}` },
    body: JSON.stringify({ expectedVersion: 1, assigneeUserId: rohanUser.id }),
  })
  assert.equal(assignRes.status, 200)

  const slaDb = await db.query(
    `SELECT s.id, s.policy_code, s.duration_seconds, s.started_at, s.deadline_at, s.status, s.acknowledged_at,
            EXTRACT(EPOCH FROM (s.deadline_at - s.started_at))::int AS diff_seconds
     FROM sla_records s
     JOIN assignments a ON a.id = s.assignment_id
     JOIN requests r ON r.id = a.request_id
     WHERE r.public_reference = $1 AND a.ended_at IS NULL`,
    [reference]
  )
  assert.equal(slaDb.rowCount, 1)
  const slaRow = slaDb.rows[0]
  assert.equal(slaRow.policy_code, 'acknowledgement_24h')
  assert.equal(slaRow.duration_seconds, 86400)
  assert.equal(slaRow.status, 'active')
  assert.equal(slaRow.diff_seconds, 86400, 'Duration between started_at and deadline_at must be exactly 86400 seconds (24h)')
  assert.equal(slaRow.acknowledged_at, null)
  console.log('  ✓ Specialist assignment initializes acknowledgement_24h SLA with exact 86400s duration')

  // 3. Healthy Acknowledgement Before Deadline
  console.log('\n3. Timely Acknowledgement Lifecycle')
  const ackRes = await fetch(`${API_ORIGIN}/v1/requests/${reference}/acknowledge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: rohanCookie, 'Idempotency-Key': `ack-${randomUUID()}` },
    body: JSON.stringify({ expectedVersion: 2 }),
  })
  assert.equal(ackRes.status, 200)
  const ackDb = await db.query('SELECT status, is_late, acknowledged_at, acknowledged_by_user_id FROM sla_records WHERE id = $1', [slaRow.id])
  assert.equal(ackDb.rows[0].status, 'acknowledged')
  assert.equal(ackDb.rows[0].is_late, false)
  assert.equal(ackDb.rows[0].acknowledged_by_user_id, rohanUser.id)
  assert.ok(ackDb.rows[0].acknowledged_at !== null)
  console.log('  ✓ Timely acknowledgement marks SLA acknowledged with is_late = false')

  // 4. Late Acknowledgement Boundary
  console.log('\n4. Late Acknowledgement Semantics (Post-Deadline)')
  // Create overdue ticket
  const lateReq = await fetch(`${API_ORIGIN}/v1/client/requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `late-${randomUUID()}` },
    body: JSON.stringify({
      name: 'Late Test Client',
      company: 'Late Corp',
      email: `late.${randomUUID().slice(0, 6)}@late.test`,
      phone: '+919876511111',
      serviceDomain: 'web_app_development',
      requirement: 'Test post-deadline late acknowledgement behavior.',
      urgency: 'time_sensitive',
    }),
  })
  const lateRef = (await lateReq.json()).reference
  await fetch(`${API_ORIGIN}/v1/pm/requests/${lateRef}/assignments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: pmCookie, 'Idempotency-Key': `assign-${randomUUID()}` },
    body: JSON.stringify({ expectedVersion: 1, assigneeUserId: rohanUser.id }),
  })

  // Manually shift deadline_at to past to simulate deadline lapse before acknowledgement
  await db.query(
    `UPDATE sla_records SET deadline_at = now() - interval '1 hour', started_at = now() - interval '25 hours'
     WHERE assignment_id = (SELECT a.id FROM assignments a JOIN requests r ON r.id = a.request_id WHERE r.public_reference = $1 AND a.ended_at IS NULL)`,
    [lateRef]
  )

  // Rohan acknowledges overdue ticket
  const lateAckRes = await fetch(`${API_ORIGIN}/v1/requests/${lateRef}/acknowledge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: rohanCookie, 'Idempotency-Key': `ack-late-${randomUUID()}` },
    body: JSON.stringify({ expectedVersion: 2 }),
  })
  assert.equal(lateAckRes.status, 200)
  const lateAckDb = await db.query(
    `SELECT s.status, s.is_late, s.acknowledged_at FROM sla_records s JOIN assignments a ON a.id = s.assignment_id JOIN requests r ON r.id = a.request_id WHERE r.public_reference = $1`,
    [lateRef]
  )
  assert.equal(lateAckDb.rows[0].status, 'breached')
  assert.equal(lateAckDb.rows[0].is_late, true)
  console.log('  ✓ Post-deadline acknowledgement correctly stamps SLA breached and is_late = true')

  // 5. Late Reassignment Breach Accountability & Escalation Isolation
  console.log('\n5. Late Reassignment Escalation Preservation')
  const overdueReq = await fetch(`${API_ORIGIN}/v1/client/requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `overdue-${randomUUID()}` },
    body: JSON.stringify({
      name: 'Overdue Client',
      company: 'Overdue Org',
      email: `overdue.${randomUUID().slice(0, 6)}@overdue.test`,
      phone: '+919876522222',
      serviceDomain: 'digital_marketing',
      requirement: 'Test late reassignment accountability preservation.',
      urgency: 'time_sensitive',
    }),
  })
  const overdueRef = (await overdueReq.json()).reference
  await fetch(`${API_ORIGIN}/v1/pm/requests/${overdueRef}/assignments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: pmCookie, 'Idempotency-Key': `assign-${randomUUID()}` },
    body: JSON.stringify({ expectedVersion: 1, assigneeUserId: rohanUser.id }),
  })

  // Shift deadline to past while preserving CHECK (deadline_at >= started_at)
  await db.query(
    `UPDATE sla_records SET started_at = now() - interval '26 hours', deadline_at = now() - interval '2 hours'
     WHERE assignment_id = (SELECT a.id FROM assignments a JOIN requests r ON r.id = a.request_id WHERE r.public_reference = $1 AND a.ended_at IS NULL)`,
    [overdueRef]
  )

  // PM reassigns overdue ticket from Rohan to Priya
  const reassignRes = await fetch(`${API_ORIGIN}/v1/pm/requests/${overdueRef}/assignments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: pmCookie, 'Idempotency-Key': `reassign-${randomUUID()}` },
    body: JSON.stringify({ expectedVersion: 2, assigneeUserId: priyaUser.id }),
  })
  assert.equal(reassignRes.status, 200)

  // Verify escalation event is permanently attached to Rohan
  const escDb = await db.query(
    `SELECT e.responsible_user_id, e.reason, e.policy_code, u.display_name
     FROM escalation_events e
     JOIN users u ON u.id = e.responsible_user_id
     JOIN requests r ON r.id = e.request_id
     WHERE r.public_reference = $1`,
    [overdueRef]
  )
  assert.equal(escDb.rowCount, 1)
  assert.equal(escDb.rows[0].responsible_user_id, rohanUser.id)
  assert.equal(escDb.rows[0].display_name, 'Rohan Mehta')

  // Verify Priya received a fresh, active, non-breached SLA
  const priyaSla = await db.query(
    `SELECT s.status, s.is_late, a.assignee_user_id
     FROM sla_records s
     JOIN assignments a ON a.id = s.assignment_id
     JOIN requests r ON r.id = a.request_id
     WHERE r.public_reference = $1 AND a.ended_at IS NULL`,
    [overdueRef]
  )
  assert.equal(priyaSla.rows[0].status, 'active')
  assert.equal(priyaSla.rows[0].is_late, false)
  assert.equal(priyaSla.rows[0].assignee_user_id, priyaUser.id)
  console.log('  ✓ Late reassignment permanently attributes breach to former specialist and gives new specialist fresh SLA')

  // 6. Resolution Closes Active SLA
  console.log('\n6. Resolution SLA Closure')
  // Priya acknowledges, starts work, and resolves
  await fetch(`${API_ORIGIN}/v1/requests/${overdueRef}/acknowledge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: priyaCookie, 'Idempotency-Key': `ack-p-${randomUUID()}` },
    body: JSON.stringify({ expectedVersion: 3 }),
  })
  await fetch(`${API_ORIGIN}/v1/requests/${overdueRef}/start-work`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: priyaCookie, 'Idempotency-Key': `start-p-${randomUUID()}` },
    body: JSON.stringify({ expectedVersion: 4 }),
  })
  const resReq = await fetch(`${API_ORIGIN}/v1/requests/${overdueRef}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: priyaCookie, 'Idempotency-Key': `resolve-p-${randomUUID()}` },
    body: JSON.stringify({ expectedVersion: 5 }),
  })
  assert.equal(resReq.status, 200)

  const closedSla = await db.query(
    `SELECT s.status FROM sla_records s JOIN assignments a ON a.id = s.assignment_id JOIN requests r ON r.id = a.request_id WHERE r.public_reference = $1 AND a.assignee_user_id = $2`,
    [overdueRef, priyaUser.id]
  )
  assert.equal(closedSla.rows[0].status, 'closed')
  console.log('  ✓ Request resolution transitions fulfilling SLA to closed')

  console.log('\n══════════════════════════════════════════════════════════════')
  console.log(' RESULTS: ALL SLA & ESCALATION FORENSIC TESTS PASSED 🎉       ')
  console.log('══════════════════════════════════════════════════════════════\n')
} finally {
  await db.end()
}
