import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

const API_URL = process.env.API_URL ?? 'http://127.0.0.1:4001'
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://nvara:nvara_local_dev_only@localhost:55432/nvara'
const db = new pg.Pool({ connectionString: DATABASE_URL })

console.log('\n══════════════════════════════════════════════════════════════')
console.log('  PHASE 18 — FRONTEND CONTRACT & UX FORENSIC TEST SUITE       ')
console.log('══════════════════════════════════════════════════════════════\n')

try {
  // ─────────────────────────────────────────────────────────────────────────────
  // 1. Auth Profile Contract (authApi.ts -> GET /v1/auth/me)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('1. Verifying Auth Profile Response Contract...')
  const loginRes = await fetch(`${API_URL}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'pm@nvaramedia.com', password: 'Nvara#PM2026!Secure' }),
  })
  assert.equal(loginRes.status, 200)
  const authCookie = loginRes.headers.get('set-cookie').split(';')[0]
  const loginBody = await loginRes.json()

  // Contract validation on User DTO
  assert.equal(typeof loginBody.user.id, 'string')
  assert.equal(typeof loginBody.user.email, 'string')
  assert.equal(typeof loginBody.user.displayName, 'string')
  assert.equal(typeof loginBody.user.role, 'string')
  assert.equal(loginBody.user.passwordHash, undefined, 'Sensitive field passwordHash must NOT be returned')
  console.log('  ✓ Auth User DTO strictly matches frontend domain/ticket User interface')

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. Client Intake Submission Contract (clientRequestApi.ts)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n2. Verifying Client Intake Response Contract...')
  const intakeRes = await fetch(`${API_URL}/v1/client/requests`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `frontend_contract_${randomUUID()}`,
    },
    body: JSON.stringify({
      name: 'UX Audit Client',
      company: 'Digital Presence Corp',
      email: `ux_${randomUUID().slice(0, 6)}@test.com`,
      phone: '+919876543210',
      serviceDomain: 'seo',
      requirement: 'Frontend contract and UI alignment forensic verification',
      urgency: 'flexible',
    }),
  })
  assert.equal(intakeRes.status, 201)
  const intakeBody = await intakeRes.json()
  assert.match(intakeBody.reference, /^NVARA-\d{4}-[A-F0-9]{8}$/)
  assert.equal(typeof intakeBody.createdAt, 'string')
  assert.equal(intakeBody.status, 'received')
  console.log('  ✓ Client intake response strictly matches SafeResponse contract')

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. Public Tracker Contract (trackerApi.ts -> GET /v1/track/:reference)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n3. Verifying Public Tracker Response Contract...')
  const trackerRes = await fetch(`${API_URL}/v1/track/${encodeURIComponent(intakeBody.reference)}`)
  assert.equal(trackerRes.status, 200)
  const trackerBody = await trackerRes.json()

  assert.equal(trackerBody.reference, intakeBody.reference)
  assert.equal(trackerBody.status, 'RECEIVED')
  assert.equal(trackerBody.statusLabel, 'Received')
  assert.equal(typeof trackerBody.serviceArea, 'string')
  assert.equal(typeof trackerBody.submittedAt, 'string')
  assert.equal(typeof trackerBody.lastUpdatedAt, 'string')
  assert.ok(Array.isArray(trackerBody.milestones))
  assert.equal(trackerBody.milestones.length, 4)
  assert.equal(trackerBody.milestones[0].type, 'REQUEST_RECEIVED')
  assert.equal(trackerBody.milestones[0].completed, true)
  console.log('  ✓ Public tracker response strictly matches PublicTrackedRequest interface')

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. Operations Queue Contract (pmRequestApi.ts -> GET /v1/pm/requests)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n4. Verifying Operations Queue Response Contract...')
  const queueRes = await fetch(`${API_URL}/v1/pm/requests`, {
    headers: { Cookie: authCookie },
  })
  assert.equal(queueRes.status, 200)
  const queueBody = await queueRes.json()
  assert.ok(Array.isArray(queueBody.requests))

  const sampleRow = queueBody.requests[0]
  assert.equal(typeof sampleRow.reference, 'string')
  assert.equal(typeof sampleRow.requirement, 'string')
  assert.equal(typeof sampleRow.urgency, 'string')
  assert.equal(typeof sampleRow.status, 'string')
  assert.equal(typeof sampleRow.version, 'number')
  assert.ok(sampleRow.client)
  assert.equal(typeof sampleRow.client.name, 'string')
  assert.equal(typeof sampleRow.client.company, 'string')
  console.log('  ✓ Operations queue response strictly matches Summary request list contract')

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. Team Directory Contract (userManagementApi.ts -> GET /v1/pm/users)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n5. Verifying Team Directory Response Contract...')
  const teamRes = await fetch(`${API_URL}/v1/pm/users`, {
    headers: { Cookie: authCookie },
  })
  assert.equal(teamRes.status, 200)
  const teamBody = await teamRes.json()
  assert.ok(Array.isArray(teamBody.users))

  const sampleMember = teamBody.users[0]
  assert.equal(typeof sampleMember.id, 'string')
  assert.equal(typeof sampleMember.displayName, 'string')
  assert.equal(typeof sampleMember.email, 'string')
  assert.equal(typeof sampleMember.role, 'string')
  assert.equal(typeof sampleMember.isActive, 'boolean')
  assert.equal(typeof sampleMember.activeAssignmentsCount, 'number')
  assert.equal(typeof sampleMember.slaComplianceRate, 'number')
  console.log('  ✓ Team directory response strictly matches OrganizationUser list contract')

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. Audit Log Contract (pmRequestApi.ts -> GET /v1/pm/audit-logs)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n6. Verifying Audit Log Response Contract...')
  const auditRes = await fetch(`${API_URL}/v1/pm/audit-logs`, {
    headers: { Cookie: authCookie },
  })
  assert.equal(auditRes.status, 200)
  const auditBody = await auditRes.json()
  assert.ok(Array.isArray(auditBody.logs))

  const sampleAudit = auditBody.logs[0]
  assert.equal(typeof sampleAudit.id, 'string')
  assert.equal(typeof sampleAudit.eventType, 'string')
  assert.equal(typeof sampleAudit.actorType, 'string')
  assert.equal(typeof sampleAudit.occurredAt, 'string')
  console.log('  ✓ Audit log response strictly matches AuditEventItem list contract')

  console.log('\n══════════════════════════════════════════════════════════════')
  console.log(' RESULTS: ALL FRONTEND CONTRACT & UX TESTS PASSED 🎉          ')
  console.log('══════════════════════════════════════════════════════════════\n')
} finally {
  await db.end()
}
