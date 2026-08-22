import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

const API_URL = process.env.API_URL ?? 'http://127.0.0.1:4001'
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://nvara:nvara_local_dev_only@localhost:55432/nvara'
const db = new pg.Pool({ connectionString: DATABASE_URL })

console.log('\n══════════════════════════════════════════════════════════════')
console.log('  PHASE 28 — AUDIT LOG PRUNING & PROVENANCE INTEGRATION PROBE ')
console.log('══════════════════════════════════════════════════════════════\n')

try {
  async function login(email, password) {
    const res = await fetch(`${API_URL}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    assert.equal(res.status, 200, `Login failed for ${email}`)
    const cookie = res.headers.get('set-cookie').split(';')[0]
    const body = await res.json()
    return { cookie, user: body.user }
  }

  const pmAuth = await login('pm@nvaramedia.com', 'Nvara#PM2026!Secure')

  // 1. Insert a test audit event into the live DB
  const testAuditId = randomUUID()
  const orgId = (await db.query("SELECT organization_id FROM users WHERE email = 'pm@nvaramedia.com'")).rows[0].organization_id
  await db.query(
    `INSERT INTO audit_events (id, organization_id, actor_user_id, actor_type, event_type, metadata)
     VALUES ($1, $2, $3, 'user', 'acknowledged', '{"testPrune": true}')`,
    [testAuditId, orgId, pmAuth.user.id]
  )
  console.log(`1. Inserted Test Audit Event: ${testAuditId}`)

  // 2. Call DELETE /v1/pm/audit-logs/:id
  console.log('2. Calling DELETE /v1/pm/audit-logs/:id...')
  const delRes = await fetch(`${API_URL}/v1/pm/audit-logs/${testAuditId}`, {
    method: 'DELETE',
    headers: { Cookie: pmAuth.cookie },
  })
  assert.equal(delRes.status, 200)
  const delBody = await delRes.json()
  assert.equal(delBody.success, true)
  assert.equal(delBody.deletedId, testAuditId)
  console.log('  ✓ Response confirmed: success=true, deletedId matches')

  // 3. Inspect database state
  console.log('3. Inspecting Database State & Immutability Trigger Behavior...')
  const dbRow = await db.query(
    `SELECT id, deleted_at, event_type, metadata FROM audit_events WHERE id = $1`,
    [testAuditId]
  )
  assert.equal(dbRow.rowCount, 1, 'Audit record MUST still exist physically in the database')
  assert.ok(dbRow.rows[0].deleted_at !== null, 'deleted_at timestamp MUST be set to now()')
  assert.equal(dbRow.rows[0].event_type, 'acknowledged', 'event_type MUST remain unchanged')
  assert.deepEqual(dbRow.rows[0].metadata, { testPrune: true }, 'metadata payload MUST remain 100% immutable')
  console.log(`  ✓ Soft-pruning verified: deleted_at=${dbRow.rows[0].deleted_at.toISOString()}`)
  console.log('  ✓ Record is retained physically; all audit payload fields remain immutable')

  // 4. Verify that the pruned audit record is excluded from GET /v1/pm/audit-logs
  console.log('\n4. Verifying Exclusion from GET /v1/pm/audit-logs Query...')
  const listRes = await fetch(`${API_URL}/v1/pm/audit-logs`, {
    headers: { Cookie: pmAuth.cookie },
  })
  assert.equal(listRes.status, 200)
  const listBody = await listRes.json()
  const found = listBody.logs.some(l => l.id === testAuditId)
  assert.equal(found, false, 'Soft-pruned record must be excluded from active audit log viewer')
  console.log('  ✓ Soft-pruned record is excluded from active compliance view')

  // 5. Test Bulk Pruning endpoint DELETE /v1/pm/audit-logs?all=true
  console.log('\n5. Testing Bulk Prune Query DELETE /v1/pm/audit-logs?olderThanDays=9999...')
  const bulkRes = await fetch(`${API_URL}/v1/pm/audit-logs?olderThanDays=9999`, {
    method: 'DELETE',
    headers: { Cookie: pmAuth.cookie },
  })
  assert.equal(bulkRes.status, 200)
  const bulkBody = await bulkRes.json()
  assert.equal(bulkBody.success, true)
  console.log(`  ✓ Bulk prune returned success with purgedCount=${bulkBody.purgedCount}`)

  console.log('\n══════════════════════════════════════════════════════════════')
  console.log(' RESULTS: AUDIT PRUNE PROVENANCE PROBE PASSED 🎉              ')
  console.log('══════════════════════════════════════════════════════════════\n')
} finally {
  await db.end()
}
