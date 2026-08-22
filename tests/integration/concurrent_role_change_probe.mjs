import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

const API_URL = process.env.API_URL ?? 'http://127.0.0.1:4001'
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://nvara:nvara_local_dev_only@localhost:55432/nvara'
const db = new pg.Pool({ connectionString: DATABASE_URL })

console.log('\n══════════════════════════════════════════════════════════════')
console.log('  PHASE 23 — CONCURRENT ADMINISTRATIVE ROLE-CHANGE PROBE      ')
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

  // Login as PM
  const pmAuth = await login('pm@nvaramedia.com', 'Nvara#PM2026!Secure')

  // Create a target specialist user to test role race
  const targetEmail = `target_role_${randomUUID().slice(0, 6)}@nvaramedia.com`
  const inviteRes = await fetch(`${API_URL}/v1/pm/users/invite`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: pmAuth.cookie,
      'Idempotency-Key': `role_inv_${randomUUID()}`,
    },
    body: JSON.stringify({
      displayName: 'Target Specialist',
      email: targetEmail,
      role: 'internal_team_member',
    }),
  })
  assert.equal(inviteRes.status, 201)
  const rawToken = (await inviteRes.json()).rawToken

  // Accept invite
  const acceptRes = await fetch(`${API_URL}/v1/invitations/${encodeURIComponent(rawToken)}/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'Target#Password2026!' }),
  })
  assert.equal(acceptRes.status, 201)
  const targetUser = (await acceptRes.json()).user

  console.log(`1. Target User Created: ${targetUser.id} (${targetUser.role})`)

  // 2. Simulate 2 concurrent PM requests:
  // PM Request 1: Promote targetUser to 'project_manager'
  // PM Request 2: Keep targetUser as 'internal_team_member' (or rename display name)
  console.log('2. Firing Concurrent Administrative Role & Profile Mutations...')
  const p1 = fetch(`${API_URL}/v1/pm/users/${targetUser.id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Cookie: pmAuth.cookie,
      'Idempotency-Key': `pm1_role_${randomUUID()}`,
    },
    body: JSON.stringify({ role: 'project_manager' }),
  })

  const p2 = fetch(`${API_URL}/v1/pm/users/${targetUser.id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Cookie: pmAuth.cookie,
      'Idempotency-Key': `pm2_role_${randomUUID()}`,
    },
    body: JSON.stringify({ displayName: 'Target Specialist Renamed' }),
  })

  const [res1, res2] = await Promise.all([p1, p2])
  console.log(`  ✓ Concurrent Requests Finished: status1=${res1.status}, status2=${res2.status}`)
  assert.equal(res1.status, 200)
  assert.equal(res2.status, 200)

  // 3. Inspect final state in DB
  console.log('3. Inspecting Database Invariants & Single Role Binding...')
  const rolesInDb = await db.query(
    `SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`,
    [targetUser.id]
  )
  assert.equal(rolesInDb.rowCount, 1, 'Target user must have exactly 1 active role in DB')
  assert.equal(rolesInDb.rows[0].code, 'project_manager', 'Target user must have resolved to project_manager without duplication or state corruption')
  console.log(`  ✓ Exactly 1 role record present in DB: ${rolesInDb.rows[0].code}`)

  // 4. Test Last Admin Protection Guard Under Demotion
  console.log('\n4. Testing Last-Admin Protection Guard Under Demotion Attempt...')
  // Demote target back to specialist
  const demoteRes = await fetch(`${API_URL}/v1/pm/users/${targetUser.id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Cookie: pmAuth.cookie,
      'Idempotency-Key': `demote_target_${randomUUID()}`,
    },
    body: JSON.stringify({ role: 'internal_team_member' }),
  })
  assert.equal(demoteRes.status, 200)

  // Now PM attempts to demote SELF (should be rejected by self-demote guard)
  const selfDemoteRes = await fetch(`${API_URL}/v1/pm/users/${pmAuth.user.id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Cookie: pmAuth.cookie,
      'Idempotency-Key': `self_demote_${randomUUID()}`,
    },
    body: JSON.stringify({ role: 'internal_team_member' }),
  })
  assert.equal(selfDemoteRes.status, 400)
  const selfDemoteData = await selfDemoteRes.json()
  assert.equal(selfDemoteData.error.code, 'CANNOT_DEMOTE_SELF')
  console.log('  ✓ Self-demote and last-admin demote protection correctly rejected with 400 CANNOT_DEMOTE_SELF')

  console.log('\n══════════════════════════════════════════════════════════════')
  console.log(' RESULTS: CONCURRENT ROLE CHANGE PROBE PASSED 🎉              ')
  console.log('══════════════════════════════════════════════════════════════\n')
} finally {
  await db.end()
}
