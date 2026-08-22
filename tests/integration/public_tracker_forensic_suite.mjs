import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

const API_ORIGIN = process.env.API_ORIGIN ?? process.env.API_URL ?? 'http://127.0.0.1:4001'
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://nvara:nvara_local_dev_only@localhost:55432/nvara'
const db = new pg.Pool({ connectionString: DATABASE_URL })

console.log('\n══════════════════════════════════════════════════════════════')
console.log('    FAANG-GRADE PUBLIC CLIENT & TRACKER FORENSIC TEST SUITE    ')
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

  // 1. Client Intake: Privilege & Attribute Injection Resistance
  console.log('1. Client Intake Attribute Injection & Strict Validator')
  const forgedPayload = {
    name: 'Attacker Client',
    company: 'Exploit Inc',
    email: 'attacker@exploit.test',
    phone: '+919876543210',
    serviceDomain: 'seo',
    requirement: 'Attempting to inject privileged server-side attributes.',
    urgency: 'soon',
    // Injected fields that must be strictly rejected
    organization_id: randomUUID(),
    role: 'project_manager',
    status: 'resolved',
    assignee_user_id: randomUUID(),
    sla_policy: 'vip_1h',
  }

  const injectRes = await fetch(`${API_ORIGIN}/v1/client/requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `inject-${randomUUID()}` },
    body: JSON.stringify(forgedPayload),
  })
  assert.equal(injectRes.status, 422, 'Strict schema must reject unrecognized injection fields')
  console.log('  ✓ Injected organization_id, role, status, assignee rejected with 422 (Strict Invariant)')

  // 2. Legitimate Intake Submission & Safe Response DTO
  console.log('\n2. Legitimate Intake & Safe Response DTO')
  const intakeRes = await fetch(`${API_ORIGIN}/v1/client/requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `valid-${randomUUID()}` },
    body: JSON.stringify({
      name: 'Pooja Agarwal',
      company: 'Luxe Interiors',
      email: `pooja.${randomUUID().slice(0, 6)}@luxe.test`,
      phone: '+919876598765',
      serviceDomain: 'seo',
      requirement: 'Need complete local SEO and Google Business Profile optimization for new Mumbai showroom.',
      urgency: 'soon',
    }),
  })
  assert.equal(intakeRes.status, 201)
  const intakeBody = await intakeRes.json()
  assert.ok(intakeBody.reference.startsWith('NVARA-'))
  assert.equal(intakeBody.status, 'received')
  // Verify intake response contains ONLY reference, createdAt, status
  const intakeKeys = Object.keys(intakeBody).sort()
  assert.deepEqual(intakeKeys, ['createdAt', 'reference', 'status'])
  console.log('  ✓ Client intake response strictly restricted to Safe Intake DTO (Zero internal IDs)')

  const ref = intakeBody.reference

  // 3. Public Tracker Lookup & Zero-Auth Access
  console.log('\n3. Public Tracker Security & DTO Allowlist Verification')
  const trackRes = await fetch(`${API_ORIGIN}/v1/track/${ref}`)
  assert.equal(trackRes.status, 200)
  assert.equal(trackRes.headers.get('cache-control'), 'no-store')
  assert.equal(trackRes.headers.get('x-robots-tag'), 'noindex, nofollow')

  const trackDto = await trackRes.json()
  const expectedDtoKeys = ['lastUpdatedAt', 'milestones', 'reference', 'serviceArea', 'status', 'statusLabel', 'submittedAt'].sort()
  assert.deepEqual(Object.keys(trackDto).sort(), expectedDtoKeys)

  // Verify initial PM triage status in public tracker is RECEIVED
  assert.equal(trackDto.status, 'RECEIVED')
  assert.equal(trackDto.statusLabel, 'Received')
  assert.equal(trackDto.milestones[0].completed, true)
  assert.equal(trackDto.milestones[1].completed, false)
  console.log('  ✓ Public tracker returns RECEIVED during PM triage and enforces no-store headers')

  // 4. Milestone Progression across Lifecycle
  console.log('\n4. Public Milestone Progression & Historical Isolation')
  const rohanUser = (await db.query("SELECT id FROM users WHERE email = 'rohan.mehta@nvaramedia.com'")).rows[0]

  // PM assigns specialist Rohan
  await fetch(`${API_ORIGIN}/v1/pm/requests/${ref}/assignments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: pmCookie, 'Idempotency-Key': `assign-${randomUUID()}` },
    body: JSON.stringify({ expectedVersion: 1, assigneeUserId: rohanUser.id }),
  })

  const trackRes2 = await fetch(`${API_ORIGIN}/v1/track/${ref}`)
  const trackDto2 = await trackRes2.json()
  assert.equal(trackDto2.status, 'ASSIGNED')
  assert.equal(trackDto2.statusLabel, 'Specialist Assigned')
  assert.equal(trackDto2.milestones[0].completed, true)
  assert.equal(trackDto2.milestones[1].completed, true)
  assert.equal(trackDto2.milestones[2].completed, false)
  assert.ok(trackDto2.milestones[1].occurredAt !== null)
  console.log('  ✓ Public tracker transitions to ASSIGNED upon specialist allocation')

  // 5. Escalation & Breach Privacy on Public Tracker
  console.log('\n5. Escalation & Breach Privacy Isolation')
  // Shift SLA deadline to past and trigger breach
  await db.query(
    `UPDATE sla_records SET started_at = now() - interval '26 hours', deadline_at = now() - interval '2 hours'
     WHERE assignment_id = (SELECT a.id FROM assignments a JOIN requests r ON r.id = a.request_id WHERE r.public_reference = $1 AND a.ended_at IS NULL)`,
    [ref]
  )

  const trackResBreach = await fetch(`${API_ORIGIN}/v1/track/${ref}`)
  const trackDtoBreach = await trackResBreach.json()
  // Ensure public status does NOT leak internal breach or escalation
  assert.equal(trackDtoBreach.status, 'ASSIGNED')
  assert.equal(JSON.stringify(trackDtoBreach).includes('breach'), false)
  assert.equal(JSON.stringify(trackDtoBreach).includes('escalat'), false)
  assert.equal(JSON.stringify(trackDtoBreach).includes('Rohan'), false)
  console.log('  ✓ Breached SLA is strictly concealed from public tracker (Zero Internal Metrics Leak)')

  // 6. Archived Request Public Tracker Hiding (404)
  console.log('\n6. Archived Request Public Tracker Hiding')
  // Complete request first
  await db.query("UPDATE requests SET status = 'resolved', resolved_at = now() WHERE public_reference = $1", [ref])
  // PM deletes / archives request
  const delRes = await fetch(`${API_ORIGIN}/v1/pm/requests/${ref}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', Cookie: pmCookie },
    body: JSON.stringify({ expectedVersion: 2 }),
  })
  assert.equal(delRes.status, 200)

  // Public tracker must now return 404 for archived request
  const trackResArchived = await fetch(`${API_ORIGIN}/v1/track/${ref}`)
  assert.equal(trackResArchived.status, 404)
  console.log('  ✓ Archived request immediately returns 404 on public tracker')

  // 7. Reference Format Validation & SQL Injection Resistance
  console.log('\n7. Reference Format Validation & Attack Resistance')
  const invalidRefs = [
    'NVARA-2026-INVALID!',
    'NVARA-2026-DROP TABLE requests',
    "' OR '1'='1",
    '../../etc/passwd',
    'NVARA-123-A',
    'a'.repeat(100),
  ]

  for (const badRef of invalidRefs) {
    const res = await fetch(`${API_ORIGIN}/v1/track/${encodeURIComponent(badRef)}`)
    assert.equal(res.status, 400, `Malformed reference '${badRef}' must return 400`)
  }
  console.log('  ✓ All malformed / injection reference strings rejected with 400 before DB lookup')

  console.log('\n══════════════════════════════════════════════════════════════')
  console.log(' RESULTS: ALL PUBLIC CLIENT & TRACKER TESTS PASSED 🎉         ')
  console.log('══════════════════════════════════════════════════════════════\n')
} finally {
  await db.end()
}
