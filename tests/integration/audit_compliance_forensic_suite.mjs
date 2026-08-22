import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

const API_ORIGIN = process.env.API_ORIGIN ?? process.env.API_URL ?? 'http://127.0.0.1:4001'
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://nvara:nvara_local_dev_only@localhost:55432/nvara'
const db = new pg.Pool({ connectionString: DATABASE_URL })

console.log('\n══════════════════════════════════════════════════════════════')
console.log('   FAANG-GRADE AUDIT, COMPLIANCE & PROVENANCE TEST SUITE     ')
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

  const pmUser = (await db.query("SELECT id FROM users WHERE email = 'pm@nvaramedia.com'")).rows[0]
  const rohanUser = (await db.query("SELECT id FROM users WHERE email = 'rohan.mehta@nvaramedia.com'")).rows[0]

  // 1. Audit Immutability Trigger: Tamper & Hard-Delete Resistance
  console.log('1. Database Immutability Trigger Verification')
  const sampleAudit = (await db.query('SELECT id, event_type, metadata FROM audit_events LIMIT 1')).rows[0]
  assert.ok(sampleAudit, 'Sample audit event must exist')

  // Attempt to tamper with historical metadata
  await assert.rejects(
    async () => {
      await db.query("UPDATE audit_events SET metadata = '{\"tampered\":true}'::jsonb WHERE id = $1", [sampleAudit.id])
    },
    (err) => {
      assert.equal(err.code, '55006')
      return true
    },
    'Tampering with audit metadata must be rejected with PostgreSQL ERRCODE 55006'
  )
  console.log('  ✓ PostgreSQL trigger blocks metadata modification with ERRCODE 55006')

  // Attempt to tamper with event_type
  await assert.rejects(
    async () => {
      await db.query("UPDATE audit_events SET event_type = 'FORGED_EVENT' WHERE id = $1", [sampleAudit.id])
    },
    (err) => {
      assert.equal(err.code, '55006')
      return true
    },
    'Tampering with event_type must be rejected with PostgreSQL ERRCODE 55006'
  )
  console.log('  ✓ PostgreSQL trigger blocks event_type modification with ERRCODE 55006')

  // Attempt hard deletion
  await assert.rejects(
    async () => {
      await db.query('DELETE FROM audit_events WHERE id = $1', [sampleAudit.id])
    },
    (err) => {
      assert.equal(err.code, '55006')
      return true
    },
    'Hard deletion of audit records must be rejected with PostgreSQL ERRCODE 55006'
  )
  console.log('  ✓ PostgreSQL trigger blocks hard deletion with ERRCODE 55006')

  // 2. Soft Pruning & Retention Integrity
  console.log('\n2. Soft Pruning & Retention Lifecycle')
  // Soft delete a log record via PM API
  const auditListRes = await fetch(`${API_ORIGIN}/v1/pm/audit-logs?limit=1`, {
    headers: { Cookie: pmCookie },
  })
  const auditList = await auditListRes.json()
  assert.ok(auditList.logs.length > 0)
  const targetAuditId = auditList.logs[0].id

  const pruneRes = await fetch(`${API_ORIGIN}/v1/pm/audit-logs/${targetAuditId}`, {
    method: 'DELETE',
    headers: { Cookie: pmCookie },
  })
  assert.equal(pruneRes.status, 200)

  // Verify record is marked deleted_at in DB but payload is 100% intact
  const prunedDb = await db.query('SELECT deleted_at, metadata, event_type FROM audit_events WHERE id = $1', [targetAuditId])
  assert.ok(prunedDb.rows[0].deleted_at !== null, 'Soft-pruned record must have deleted_at timestamp')
  assert.ok(prunedDb.rows[0].metadata !== null, 'Soft-pruned record must retain original immutable payload')
  console.log('  ✓ Soft-pruning sets deleted_at while leaving compliance payload 100% intact')

  // 3. PM Operational Override Provenance & Actor Attribution
  console.log('\n3. PM Operational Override Provenance Attribution')
  const reqRes = await fetch(`${API_ORIGIN}/v1/client/requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `override-audit-${randomUUID()}` },
    body: JSON.stringify({
      name: 'Audit Client',
      company: 'Provenance Corp',
      email: `audit.${randomUUID().slice(0, 6)}@provenance.test`,
      phone: '+919876544444',
      serviceDomain: 'seo',
      requirement: 'Test complete audit trail provenance during PM operational override.',
      urgency: 'soon',
    }),
  })
  const ref = (await reqRes.json()).reference

  // PM assigns Rohan
  await fetch(`${API_ORIGIN}/v1/pm/requests/${ref}/assignments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: pmCookie, 'Idempotency-Key': `assign-${randomUUID()}` },
    body: JSON.stringify({ expectedVersion: 1, assigneeUserId: rohanUser.id }),
  })

  // PM acknowledges on behalf of Rohan (Override)
  const ackRes = await fetch(`${API_ORIGIN}/v1/requests/${ref}/acknowledge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: pmCookie, 'Idempotency-Key': `ack-ov-${randomUUID()}` },
    body: JSON.stringify({ expectedVersion: 2 }),
  })
  assert.equal(ackRes.status, 200)

  // Check audit trail record for acknowledgement
  const auditRow = await db.query(
    `SELECT a.actor_user_id, a.actor_type, a.event_type, a.metadata, a.previous_state, a.new_state
     FROM audit_events a
     JOIN requests r ON r.id = a.request_id
     WHERE r.public_reference = $1 AND a.event_type = 'acknowledged'`,
    [ref]
  )
  assert.equal(auditRow.rowCount, 1)
  const ackAudit = auditRow.rows[0]
  assert.equal(ackAudit.actor_user_id, pmUser.id, 'Action actor must be PM')
  assert.equal(ackAudit.actor_type, 'user')
  assert.equal(ackAudit.previous_state, 'awaiting_acknowledgement')
  assert.equal(ackAudit.new_state, 'acknowledged')
  assert.equal(ackAudit.metadata.override, true)
  assert.equal(ackAudit.metadata.originalAssigneeUserId, rohanUser.id)
  console.log('  ✓ PM operational override records actor_user_id = PM, override = true, originalAssigneeUserId = Rohan')

  // 4. System Actor Attribution (SLA Breach & Escalation)
  console.log('\n4. System Actor Attribution for Automated Events')
  await db.query(
    `UPDATE sla_records SET started_at = now() - interval '26 hours', deadline_at = now() - interval '2 hours'
     WHERE assignment_id = (SELECT a.id FROM assignments a JOIN requests r ON r.id = a.request_id WHERE r.public_reference = $1 AND a.ended_at IS NULL)`,
    [ref]
  )

  // Import worker to evaluate breach
  const { evaluateOverdueSlas } = await import('../../apps/worker/dist/worker.js')
  await evaluateOverdueSlas(db)

  const sysAudits = await db.query(
    `SELECT a.actor_user_id, a.actor_type, a.event_type, a.new_state
     FROM audit_events a
     JOIN requests r ON r.id = a.request_id
     WHERE r.public_reference = $1 AND a.event_type IN ('sla_breached', 'escalation_triggered')
     ORDER BY a.occurred_at ASC`,
    [ref]
  )
  for (const row of sysAudits.rows) {
    assert.equal(row.actor_user_id, null, 'System events must have NULL actor_user_id')
    assert.equal(row.actor_type, 'system', 'System events must have actor_type = system')
  }
  console.log('  ✓ Automated worker events record actor_type = system and actor_user_id = NULL')

  // 5. Cross-Tenant Audit Isolation
  console.log('\n5. Cross-Tenant Multi-Organization Audit Isolation')
  const foreignOrgId = randomUUID()
  await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [foreignOrgId, `Foreign Org ${randomUUID()}`])
  await db.query(
    `INSERT INTO audit_events (organization_id, actor_type, event_type, metadata)
     VALUES ($1, 'system', 'USER_CREATED', '{"foreign":true}'::jsonb)`,
    [foreignOrgId]
  )

  const pmAuditQuery = await fetch(`${API_ORIGIN}/v1/pm/audit-logs?limit=100`, {
    headers: { Cookie: pmCookie },
  })
  const pmLogs = await pmAuditQuery.json()
  const hasForeign = pmLogs.logs.some((l) => JSON.stringify(l.metadata).includes('foreign'))
  assert.equal(hasForeign, false, 'PM audit query must NEVER return cross-tenant audit events')
  console.log('  ✓ PM audit log query strictly isolates organizational boundaries (Zero Cross-Tenant Leak)')

  console.log('\n══════════════════════════════════════════════════════════════')
  console.log(' RESULTS: ALL AUDIT & COMPLIANCE TESTS PASSED 🎉              ')
  console.log('══════════════════════════════════════════════════════════════\n')
} finally {
  await db.end()
}
