import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { loadConfig } from '../../packages/config/dist/env.js'

const API_URL = process.env.API_URL ?? 'http://127.0.0.1:4001'
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://nvara:nvara_local_dev_only@localhost:55432/nvara'
const db = new pg.Pool({ connectionString: DATABASE_URL })

console.log('\n══════════════════════════════════════════════════════════════')
console.log('  PHASE 17 — PRODUCTION READINESS FORENSIC TEST SUITE         ')
console.log('══════════════════════════════════════════════════════════════\n')

try {
  // ─────────────────────────────────────────────────────────────────────────────
  // 1. Test-Only Route Isolation in Production (404 Verification)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('1. Test-Only Route Isolation in Production...')
  const testRouteRes = await fetch(`${API_URL}/v1/test/reset-tracker-rate-limit`, { method: 'POST' })
  assert.equal(testRouteRes.status, 404, 'Test-only routes must return 404 in production environment')
  const testRouteBody = await testRouteRes.json()
  assert.equal(testRouteBody.error.code, 'NOT_FOUND')
  console.log('  ✓ Test-only reset route is completely excluded and returns 404 in production')

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. Dev-Auth Bypass Immunity in Production
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n2. Dev-Auth Header Immunity in Production...')
  const devAuthRes = await fetch(`${API_URL}/v1/pm/requests`, {
    headers: {
      'x-dev-auth-subject': 'pm@nvaramedia.com',
      'x-dev-auth-role': 'project_manager',
    },
  })
  assert.equal(devAuthRes.status, 401, 'Dev auth headers must be completely ignored in production')
  const devAuthBody = await devAuthRes.json()
  assert.equal(devAuthBody.error.code, 'UNAUTHENTICATED')
  console.log('  ✓ Dev-auth headers are strictly ignored in production (returns 401 UNAUTHENTICATED)')

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. Session Cookie Security Attributes
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n3. Session Cookie Security Attributes...')
  const loginRes = await fetch(`${API_URL}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'pm@nvaramedia.com', password: 'Nvara#PM2026!Secure' }),
  })
  assert.equal(loginRes.status, 200)
  const setCookieHeader = loginRes.headers.get('set-cookie')
  assert.ok(setCookieHeader, 'Set-Cookie header must be present')
  assert.ok(setCookieHeader.toLowerCase().includes('httponly'), 'Cookie must specify HttpOnly')
  assert.ok(setCookieHeader.toLowerCase().includes('samesite=lax') || setCookieHeader.toLowerCase().includes('samesite=strict'), 'Cookie must specify SameSite')
  assert.ok(setCookieHeader.toLowerCase().includes('path=/'), 'Cookie must specify Path=/')
  console.log('  ✓ Session cookie is guarded with HttpOnly, Path=/, and SameSite')

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. Database Migration Verification & Schema Tracking
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n4. Database Migration Verification & Schema Tracking...')
  const migrationsRes = await db.query('SELECT version FROM schema_migrations ORDER BY version')
  assert.equal(migrationsRes.rows.length, 12, 'Exactly 12 migrations must be tracked in schema_migrations')
  const migrationVersions = migrationsRes.rows.map(r => r.version)
  assert.ok(migrationVersions.includes('0001_initial'))
  assert.ok(migrationVersions.includes('0012_invitation_audit_events'))
  console.log('  ✓ All 12 forward migrations are verified and tracked in schema_migrations')

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. Environment Config Fail-Fast Validation
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n5. Environment Config Fail-Fast Validation...')
  assert.throws(
    () => {
      loadConfig({
        NODE_ENV: 'production',
        DATABASE_URL: '', // Invalid empty string
        WEB_ORIGIN: 'http://127.0.0.1:3000',
      })
    },
    (err) => {
      assert.ok(err.message.includes('Invalid environment configuration'))
      return true
    }
  )
  console.log('  ✓ Missing or malformed environment variables trigger immediate fail-fast error')

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. Probes & Health Endpoint Semantics
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n6. Deployment Probes (/health, /health/live, /health/ready)...')
  const livenessRes = await fetch(`${API_URL}/health/live`)
  assert.equal(livenessRes.status, 200)
  const readinessRes = await fetch(`${API_URL}/health/ready`)
  assert.equal(readinessRes.status, 200)
  console.log('  ✓ Liveness probe (/health/live) and readiness probe (/health/ready) verified')

  console.log('\n══════════════════════════════════════════════════════════════')
  console.log(' RESULTS: ALL PRODUCTION READINESS TESTS PASSED 🎉           ')
  console.log('══════════════════════════════════════════════════════════════\n')
} finally {
  await db.end()
}
