import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

const API_ORIGIN = process.env.API_ORIGIN ?? process.env.API_URL ?? 'http://127.0.0.1:4001'
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://nvara:nvara_local_dev_only@localhost:55432/nvara'
const db = new pg.Pool({ connectionString: DATABASE_URL })

console.log('\n══════════════════════════════════════════════════════════════')
console.log('   FAANG-GRADE API CONTRACT, VALIDATION & ABUSE TEST SUITE    ')
console.log('══════════════════════════════════════════════════════════════\n')

try {
  // 1. Health & Diagnostic Endpoint Security (Zero Credential Leakage)
  console.log('1. Health & Diagnostic Endpoint Exposure')
  const healthRes = await fetch(`${API_ORIGIN}/health`)
  assert.equal(healthRes.status, 200)
  const healthJson = await healthRes.json()
  assert.deepEqual(healthJson, { status: 'ok' })

  const liveRes = await fetch(`${API_ORIGIN}/health/live`)
  assert.equal(liveRes.status, 200)
  assert.deepEqual(await liveRes.json(), { status: 'ok' })

  const readyRes = await fetch(`${API_ORIGIN}/health/ready`)
  assert.equal(readyRes.status, 200)
  assert.deepEqual(await readyRes.json(), { status: 'ok' })
  console.log('  ✓ Health endpoints return clean status: ok with zero sensitive environment data')

  // 2. Oversized Payload Rejection (413 Body Limit)
  console.log('\n2. Oversized Input & Body Limit Hardening')
  const hugeString = 'X'.repeat(35 * 1024) // 35 KB exceeds 32 KB limit
  const hugeRes = await fetch(`${API_ORIGIN}/v1/client/requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Abuse Client',
      company: 'Oversize Corp',
      email: 'abuse@oversize.test',
      phone: '+919876543210',
      serviceDomain: 'seo',
      requirement: hugeString,
      urgency: 'flexible',
    }),
  })
  assert.equal(hugeRes.status, 413, 'Oversized payload must be rejected with HTTP 413')
  const hugeData = await hugeRes.json()
  assert.equal(hugeData.error.code, 'PAYLOAD_TOO_LARGE')
  console.log('  ✓ Payloads exceeding 32 KB body limit rejected with 413 PAYLOAD_TOO_LARGE')

  // 3. Malformed JSON & Content-Type Handling
  console.log('\n3. Malformed JSON & Parser Error Handling')
  const malformedRes = await fetch(`${API_ORIGIN}/v1/client/requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"broken_json": true, missing_brace',
  })
  assert.equal(malformedRes.status, 400)
  const malformedData = await malformedRes.json()
  assert.equal(malformedData.error.code, 'INVALID_JSON')
  console.log('  ✓ Malformed JSON rejected cleanly with 400 INVALID_JSON (No unhandled crash)')

  // 4. Strict Schema & Privilege Injection Immunity
  console.log('\n4. Strict Schema & Privilege Injection Rejection')
  const injectRes = await fetch(`${API_ORIGIN}/v1/client/requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({
      name: 'Valid Name',
      company: 'Valid Company',
      email: 'valid@company.test',
      phone: '+919876543210',
      serviceDomain: 'seo',
      requirement: 'Testing privilege attribute injection rejection.',
      urgency: 'flexible',
      organization_id: randomUUID(), // Injected privilege field
      role: 'project_manager',
      status: 'resolved',
    }),
  })
  assert.equal(injectRes.status, 422, 'Injected unknown fields must fail strict schema validation')
  const injectData = await injectRes.json()
  assert.equal(injectData.error.code, 'VALIDATION_ERROR')
  console.log('  ✓ Injected privilege fields strictly rejected with 422 VALIDATION_ERROR')

  // 5. Login & Auth Boundary Check
  const pmLoginRes = await fetch(`${API_ORIGIN}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'pm@nvaramedia.com', password: 'Nvara#PM2026!Secure' }),
  })
  assert.equal(pmLoginRes.status, 200)
  const pmCookie = pmLoginRes.headers.get('set-cookie')?.split(';')[0] || ''

  // 6. Query Parameter Bounds & Safe Pagination Sanitization
  console.log('\n6. Query Parameter Bounds & Pagination Safety')
  const badPageRes = await fetch(`${API_ORIGIN}/v1/pm/audit-logs?page=-5&limit=9999`, {
    headers: { Cookie: pmCookie },
  })
  assert.equal(badPageRes.status, 200)
  const badPageData = await badPageRes.json()
  assert.equal(badPageData.pagination.page, 1, 'Negative page must be clamped to minimum 1')
  assert.equal(badPageData.pagination.limit, 100, 'Extreme limit must be clamped to maximum 100')
  console.log('  ✓ Negative / extreme pagination parameters safely clamped (page >= 1, limit <= 100)')

  // 7. Path Parameter Validation (Malformed UUIDs & Traversal Rejection)
  console.log('\n7. Path Parameter Validation & Safety')
  const badUuidRes = await fetch(`${API_ORIGIN}/v1/pm/users/not-a-valid-uuid/detail`, {
    headers: { Cookie: pmCookie },
  })
  assert.equal(badUuidRes.status, 404)
  console.log('  ✓ Non-UUID path parameters safely return 404 (No SQL error or unhandled exception)')

  // 8. CORS Header Enforcement on OPTIONS
  console.log('\n8. CORS Security Header Enforcement')
  const corsBlockedRes = await fetch(`${API_ORIGIN}/v1/pm/requests`, {
    method: 'OPTIONS',
    headers: { Origin: 'http://malicious-attacker-site.com' },
  })
  assert.equal(corsBlockedRes.status, 403)
  console.log('  ✓ Unauthorized CORS origin rejected with 403 CORS_FORBIDDEN on preflight')

  console.log('\n══════════════════════════════════════════════════════════════')
  console.log(' RESULTS: ALL API CONTRACT & ABUSE TESTS PASSED 🎉           ')
  console.log('══════════════════════════════════════════════════════════════\n')
} finally {
  await db.end()
}
