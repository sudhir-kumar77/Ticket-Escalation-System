import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

const API_URL = process.env.API_URL ?? 'http://127.0.0.1:4001'
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://nvara:nvara_local_dev_only@localhost:55432/nvara'
const db = new pg.Pool({ connectionString: DATABASE_URL })

console.log('\n══════════════════════════════════════════════════════════════')
console.log('  PHASE 24 — COMPETING LAST-ADMIN CONCURRENCY RACE PROBE      ')
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

  // Create isolated organization with exactly 2 PMs
  const isolatedOrgId = randomUUID()
  const pm1Id = randomUUID()
  const pm2Id = randomUUID()
  const pm1Email = `pm1_race_${randomUUID().slice(0, 6)}@isolated.com`
  const pm2Email = `pm2_race_${randomUUID().slice(0, 6)}@isolated.com`

  await db.query(`INSERT INTO organizations (id, name) VALUES ($1, $2)`, [isolatedOrgId, `Isolated Race Org ${randomUUID().slice(0, 6)}`])
  const pmRoleId = (await db.query("SELECT id FROM roles WHERE code = 'project_manager'")).rows[0].id
  const sharedPasswordHash = (await db.query("SELECT password_hash FROM users WHERE email = 'pm@nvaramedia.com'")).rows[0].password_hash

  await db.query(
    `INSERT INTO users (id, organization_id, email, display_name, password_hash, is_active)
     VALUES ($1, $2, $3, 'PM One', $4, true), ($5, $2, $6, 'PM Two', $4, true)`,
    [pm1Id, isolatedOrgId, pm1Email, sharedPasswordHash, pm2Id, pm2Email]
  )
  await db.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $3), ($2, $3)`, [pm1Id, pm2Id, pmRoleId])

  const pm1Auth = await login(pm1Email, 'Nvara#PM2026!Secure')
  const pm2Auth = await login(pm2Email, 'Nvara#PM2026!Secure')

  console.log(`1. Initialized Isolated Org with Exactly 2 PMs: ${pm1Email}, ${pm2Email}`)

  // 2. Competing simultaneous demotions:
  // PM1 attempts to demote PM2 -> Specialist
  // PM2 attempts to demote PM1 -> Specialist
  console.log('2. Firing Simultaneous Competing Demotions (PM-1 demoting PM-2 vs PM-2 demoting PM-1)...')
  const req1 = fetch(`${API_URL}/v1/pm/users/${pm2Id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Cookie: pm1Auth.cookie,
      'Idempotency-Key': `compete_pm1_${randomUUID()}`,
    },
    body: JSON.stringify({ role: 'internal_team_member' }),
  })

  const req2 = fetch(`${API_URL}/v1/pm/users/${pm1Id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Cookie: pm2Auth.cookie,
      'Idempotency-Key': `compete_pm2_${randomUUID()}`,
    },
    body: JSON.stringify({ role: 'internal_team_member' }),
  })

  const [res1, res2] = await Promise.all([req1, req2])
  console.log(`  ✓ Race Executed: res1=${res1.status}, res2=${res2.status}`)

  // 3. Inspect final state in DB
  const activePms = await db.query(`
    SELECT u.id, u.email, r.code AS role, u.is_active
    FROM users u
    JOIN user_roles ur ON ur.user_id = u.id
    JOIN roles r ON r.id = ur.role_id
    WHERE u.organization_id = $1 AND r.code = 'project_manager' AND u.is_active = true
  `, [isolatedOrgId])

  console.log(`3. Active PMs Remaining in Org: ${activePms.rowCount}`)
  assert.ok(activePms.rowCount >= 1, 'Organization MUST maintain at least 1 active Project Manager (cannot drop to 0)')

  // 4. Test Final Demotion on the Single Remaining PM
  const remainingPmId = activePms.rows[0].id
  const otherPmAuth = remainingPmId === pm1Id ? pm1Auth : pm2Auth

  console.log('\n4. Attempting to Demote the Sole Remaining PM...')
  const finalDemoteRes = await fetch(`${API_URL}/v1/pm/users/${remainingPmId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Cookie: otherPmAuth.cookie,
      'Idempotency-Key': `final_demote_${randomUUID()}`,
    },
    body: JSON.stringify({ role: 'internal_team_member' }),
  })
  assert.equal(finalDemoteRes.status, 400)
  const finalErr = await finalDemoteRes.json()
  assert.ok(
    ['CANNOT_REMOVE_LAST_ADMIN', 'CANNOT_DEMOTE_SELF'].includes(finalErr.error.code),
    `Expected CANNOT_REMOVE_LAST_ADMIN or CANNOT_DEMOTE_SELF, got ${finalErr.error.code}`
  )
  console.log(`  ✓ Blocked with ${finalErr.error.code}: "${finalErr.error.message}"`)

  console.log('\n══════════════════════════════════════════════════════════════')
  console.log(' RESULTS: COMPETING LAST-ADMIN RACE PROBE PASSED 🎉          ')
  console.log('══════════════════════════════════════════════════════════════\n')
} finally {
  await db.end()
}
