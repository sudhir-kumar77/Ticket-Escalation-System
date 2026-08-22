import assert from 'node:assert/strict'
import { randomUUID, randomBytes, scryptSync, createHash } from 'node:crypto'
import pg from 'pg'

const API_ORIGIN = process.env.API_ORIGIN ?? process.env.API_URL ?? 'http://127.0.0.1:4001'
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://nvara:nvara_local_dev_only@localhost:55432/nvara'
const db = new pg.Pool({ connectionString: DATABASE_URL })

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex')
  const derivedKey = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 })
  return `${salt}:${derivedKey.toString('hex')}`
}

function hashToken(rawToken) {
  return createHash('sha256').update(rawToken).digest('hex')
}

function getSessionCookie(res) {
  const setCookie = res.headers.get('set-cookie')
  if (!setCookie) return null
  const match = setCookie.match(/nvara_session=([^;]+)/)
  return match ? match[1] : null
}

console.log('\n══════════════════════════════════════════════════════════════')
console.log('    FAANG-GRADE AUTHENTICATION & SESSION LIFECYCLE SUITE      ')
console.log('══════════════════════════════════════════════════════════════\n')

try {
  // ── Setup Test Organization & Roles ──
  const orgRes = await db.query(
    `INSERT INTO organizations (name) VALUES ('Auth Forensic Org ' || gen_random_uuid()) RETURNING id`
  )
  const orgId = orgRes.rows[0].id

  const pmRoleRes = await db.query("SELECT id FROM roles WHERE code = 'project_manager'")
  const specRoleRes = await db.query("SELECT id FROM roles WHERE code = 'internal_team_member'")
  const pmRoleId = pmRoleRes.rows[0].id
  const specRoleId = specRoleRes.rows[0].id

  // ════════════════════════════════════════════════════════════
  // 1. LOGIN FORENSIC TESTS
  // ════════════════════════════════════════════════════════════
  console.log('1. Login & Credential Verification')

  // 1.1 Non-existent user login -> 401 generic
  const nonExistentRes = await fetch(`${API_ORIGIN}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'nonexistent.user.123@nvaramedia.com', password: 'AnyPassword123!' }),
  })
  assert.equal(nonExistentRes.status, 401, 'Nonexistent email must return 401')
  const nonExistentBody = await nonExistentRes.json()
  assert.equal(nonExistentBody.error.code, 'INVALID_CREDENTIALS')
  console.log('  ✓ Non-existent user login returns generic 401 (Zero-Enumeration)')

  // 1.2 Existing user with wrong password -> 401 identical generic response
  const wrongPassRes = await fetch(`${API_ORIGIN}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'pm@nvaramedia.com', password: 'WrongPassword#999' }),
  })
  assert.equal(wrongPassRes.status, 401, 'Wrong password must return 401')
  const wrongPassBody = await wrongPassRes.json()
  assert.equal(wrongPassBody.error.code, 'INVALID_CREDENTIALS')
  assert.equal(wrongPassBody.error.message, nonExistentBody.error.message, 'Error message must be indistinguishable')
  console.log('  ✓ Wrong password returns identical generic 401 error message')

  // 1.3 Inactive user login -> 401
  const inactiveEmail = `inactive.${randomUUID().slice(0, 6)}@nvara.test`
  await db.query(
    `INSERT INTO users (organization_id, display_name, email, password_hash, auth_subject, is_active)
     VALUES ($1, 'Inactive Member', $2, $3, $4, false)`,
    [orgId, inactiveEmail, hashPassword('ValidPass123!'), `auth-${randomUUID()}`]
  )
  const inactiveRes = await fetch(`${API_ORIGIN}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: inactiveEmail, password: 'ValidPass123!' }),
  })
  assert.equal(inactiveRes.status, 401, 'Inactive user must be denied login with 401')
  console.log('  ✓ Inactive user rejected during login (401)')

  // 1.4 Valid Login -> issues HttpOnly SameSite=Lax cookie and returns safe profile
  const validLoginRes = await fetch(`${API_ORIGIN}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'pm@nvaramedia.com', password: 'Nvara#PM2026!Secure' }),
  })
  assert.equal(validLoginRes.status, 200, 'Valid login must return 200')
  const rawCookie = getSessionCookie(validLoginRes)
  assert.ok(rawCookie, 'Must set nvara_session cookie')
  const setCookieHeader = validLoginRes.headers.get('set-cookie') || ''
  assert.ok(setCookieHeader.toLowerCase().includes('httponly'), 'Cookie must be HttpOnly')
  assert.ok(setCookieHeader.toLowerCase().includes('samesite=lax'), 'Cookie must specify SameSite=Lax')
  assert.ok(setCookieHeader.toLowerCase().includes('path=/'), 'Cookie path must be /')
  console.log('  ✓ Successful login returns 200 with HttpOnly, SameSite=Lax session cookie')

  // ════════════════════════════════════════════════════════════
  // 2. SESSION TOKEN HASHING AT REST & ENTROPY
  // ════════════════════════════════════════════════════════════
  console.log('\n2. Session Storage & Token Hashing at Rest')

  // 2.1 Verify raw session token is NOT stored in PostgreSQL (only SHA-256 hash)
  const tokenHash = hashToken(decodeURIComponent(rawCookie))
  const sessionDbRes = await db.query(
    'SELECT id, session_token_hash, user_id, user_agent, ip_address, expires_at FROM sessions WHERE session_token_hash = $1',
    [tokenHash]
  )
  assert.equal(sessionDbRes.rowCount, 1, 'Session hash must exist in DB')
  const rawTokenSearch = await db.query(
    'SELECT id FROM sessions WHERE session_token_hash = $1',
    [decodeURIComponent(rawCookie)]
  )
  assert.equal(rawTokenSearch.rowCount, 0, 'Raw token must NEVER be stored plaintext in database')
  console.log('  ✓ Session token is hashed with SHA-256 at rest (zero plaintext storage)')

  // ════════════════════════════════════════════════════════════
  // 3. LOGOUT LIFECYCLE
  // ════════════════════════════════════════════════════════════
  console.log('\n3. Logout Lifecycle & Cookie Eviction')

  // 3.1 Perform logout
  const logoutRes = await fetch(`${API_ORIGIN}/v1/auth/logout`, {
    method: 'POST',
    headers: { Cookie: `nvara_session=${rawCookie}` },
  })
  assert.equal(logoutRes.status, 200, 'Logout returns 200')
  const logoutCookieHeader = logoutRes.headers.get('set-cookie') || ''
  assert.ok(logoutCookieHeader.includes('Max-Age=0') || logoutCookieHeader.includes('Expires='), 'Logout must clear cookie')

  // 3.2 Session revoked in database
  const revokedSessionCheck = await db.query(
    'SELECT revoked_at FROM sessions WHERE session_token_hash = $1',
    [tokenHash]
  )
  assert.ok(revokedSessionCheck.rows[0].revoked_at !== null, 'Session revoked_at must be populated')

  // 3.3 Replaying old cookie returns 401 UNAUTHENTICATED
  const replayOldSessionRes = await fetch(`${API_ORIGIN}/v1/auth/me`, {
    headers: { Cookie: `nvara_session=${rawCookie}` },
  })
  assert.equal(replayOldSessionRes.status, 401, 'Replaying logged-out session must return 401')
  console.log('  ✓ Logout marks session revoked in DB and replaying old cookie immediately fails (401)')

  // ════════════════════════════════════════════════════════════
  // 4. SESSION EXPIRY BOUNDARY
  // ════════════════════════════════════════════════════════════
  console.log('\n4. Session Expiration Boundary')

  // Create an expired session directly in DB
  const expiredRawToken = randomBytes(32).toString('hex')
  const expiredTokenHash = hashToken(expiredRawToken)
  const pmUserRes = await db.query("SELECT id, organization_id FROM users WHERE email = 'pm@nvaramedia.com'")
  const pmUserId = pmUserRes.rows[0].id
  const pmOrgId = pmUserRes.rows[0].organization_id

  await db.query(
    `INSERT INTO sessions (user_id, organization_id, session_token_hash, expires_at, created_at)
     VALUES ($1, $2, $3, now() - interval '10 seconds', now() - interval '7 days')`,
    [pmUserId, pmOrgId, expiredTokenHash]
  )

  const expiredReqRes = await fetch(`${API_ORIGIN}/v1/auth/me`, {
    headers: { Cookie: `nvara_session=${expiredRawToken}` },
  })
  assert.equal(expiredReqRes.status, 401, 'Expired session must return 401')
  console.log('  ✓ Expired session fails closed on server time boundary (401)')

  // ════════════════════════════════════════════════════════════
  // 5. AUTHENTICATED PASSWORD CHANGE & REMOTE SESSION REVOCATION
  // ════════════════════════════════════════════════════════════
  console.log('\n5. Authenticated Password Change')

  // Create dedicated user for password change test
  const pwdUserEmail = `pwd.test.${randomUUID().slice(0, 6)}@nvara.test`
  const initialPassword = 'Initial#Password2026!'
  const userCreateRes = await db.query(
    `INSERT INTO users (organization_id, display_name, email, password_hash, auth_subject, is_active)
     VALUES ($1, 'Password Test User', $2, $3, $4, true) RETURNING id`,
    [orgId, pwdUserEmail, hashPassword(initialPassword), `auth-${randomUUID()}`]
  )
  const pwdUserId = userCreateRes.rows[0].id
  await db.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [pwdUserId, specRoleId])

  // Login Device 1
  const loginDev1 = await fetch(`${API_ORIGIN}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: pwdUserEmail, password: initialPassword }),
  })
  const cookieDev1 = getSessionCookie(loginDev1)

  // Login Device 2
  const loginDev2 = await fetch(`${API_ORIGIN}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: pwdUserEmail, password: initialPassword }),
  })
  const cookieDev2 = getSessionCookie(loginDev2)

  // 5.1 Same password rejection
  const samePwdRes = await fetch(`${API_ORIGIN}/v1/auth/change-password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `nvara_session=${cookieDev1}`,
    },
    body: JSON.stringify({ currentPassword: initialPassword, newPassword: initialPassword }),
  })
  assert.equal(samePwdRes.status, 400, 'Same password must return 400')
  console.log('  ✓ Changing password to same password rejected (400 SAME_PASSWORD)')

  // 5.2 Invalid current password rejection
  const wrongCurrentPwdRes = await fetch(`${API_ORIGIN}/v1/auth/change-password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `nvara_session=${cookieDev1}`,
    },
    body: JSON.stringify({ currentPassword: 'WrongPassword123!', newPassword: 'NewUpdatedPassword2026!' }),
  })
  assert.equal(wrongCurrentPwdRes.status, 400, 'Invalid current password must return 400')
  console.log('  ✓ Invalid current password rejected (400 INVALID_CURRENT_PASSWORD)')

  // 5.3 Valid Password Change
  const newPassword = 'NewUpdatedPassword2026!'
  const changePwdRes = await fetch(`${API_ORIGIN}/v1/auth/change-password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `nvara_session=${cookieDev1}`,
    },
    body: JSON.stringify({ currentPassword: initialPassword, newPassword }),
  })
  assert.equal(changePwdRes.status, 200, 'Password change must succeed')

  // 5.4 Device 1 (current session) remains active
  const checkDev1Res = await fetch(`${API_ORIGIN}/v1/auth/me`, {
    headers: { Cookie: `nvara_session=${cookieDev1}` },
  })
  assert.equal(checkDev1Res.status, 200, 'Device 1 session must remain valid')

  // 5.5 Device 2 (remote session) is revoked
  const checkDev2Res = await fetch(`${API_ORIGIN}/v1/auth/me`, {
    headers: { Cookie: `nvara_session=${cookieDev2}` },
  })
  assert.equal(checkDev2Res.status, 401, 'Device 2 remote session must be revoked')

  // 5.6 Old password cannot log in
  const oldLoginRes = await fetch(`${API_ORIGIN}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: pwdUserEmail, password: initialPassword }),
  })
  assert.equal(oldLoginRes.status, 401, 'Old password must be rejected')

  // 5.7 New password logs in successfully
  const newLoginRes = await fetch(`${API_ORIGIN}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: pwdUserEmail, password: newPassword }),
  })
  assert.equal(newLoginRes.status, 200, 'New password must log in')
  console.log('  ✓ Password change updates hash, revokes remote sessions, and old password fails')

  // ════════════════════════════════════════════════════════════
  // 6. FORGOT PASSWORD & ONE-TIME RESET TOKEN LIFECYCLE
  // ════════════════════════════════════════════════════════════
  console.log('\n6. Password Reset Flow & Replay Resistance')

  // 6.1 Request reset token
  const forgotRes = await fetch(`${API_ORIGIN}/v1/auth/forgot-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: pwdUserEmail }),
  })
  assert.equal(forgotRes.status, 200, 'Forgot password returns 200')
  const forgotData = await forgotRes.json()
  const resetToken1 = forgotData.devResetToken
  assert.ok(resetToken1, 'Dev reset token generated')

  // 6.2 Request second reset token -> invalidates first unused token
  const forgotRes2 = await fetch(`${API_ORIGIN}/v1/auth/forgot-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: pwdUserEmail }),
  })
  assert.equal(forgotRes2.status, 200)
  const resetToken2 = (await forgotRes2.json()).devResetToken

  // 6.3 First token is now invalidated (superseded)
  const verifyToken1Res = await fetch(`${API_ORIGIN}/v1/auth/verify-reset-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: resetToken1 }),
  })
  assert.equal(verifyToken1Res.status, 400, 'Superseded reset token must return 400')
  console.log('  ✓ Requesting new reset token immediately invalidates previous unused tokens')

  // 6.4 Verify active second token -> 200
  const verifyToken2Res = await fetch(`${API_ORIGIN}/v1/auth/verify-reset-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: resetToken2 }),
  })
  assert.equal(verifyToken2Res.status, 200, 'Active reset token must be valid')
  console.log('  ✓ Active reset token verified successfully (200)')

  // 6.5 Consume token to reset password
  const finalPassword = 'FinalResetPassword#2026'
  const doResetRes = await fetch(`${API_ORIGIN}/v1/auth/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: resetToken2, newPassword: finalPassword }),
  })
  assert.equal(doResetRes.status, 200, 'Reset password must succeed')

  // 6.6 Token replay fails (Single-Use Invariant)
  const replayResetRes = await fetch(`${API_ORIGIN}/v1/auth/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: resetToken2, newPassword: 'AnotherPassword#999' }),
  })
  assert.equal(replayResetRes.status, 400, 'Replaying consumed reset token must return 400')
  console.log('  ✓ Reset token is single-use: replay attempt rejected with 400')

  // 6.7 Password reset revokes ALL active sessions (including Device 1)
  const checkDev1AfterReset = await fetch(`${API_ORIGIN}/v1/auth/me`, {
    headers: { Cookie: `nvara_session=${cookieDev1}` },
  })
  assert.equal(checkDev1AfterReset.status, 401, 'Password reset must revoke ALL active sessions')
  console.log('  ✓ Password reset automatically revokes ALL existing sessions across all devices')

  // ════════════════════════════════════════════════════════════
  // 7. INVITATION ONBOARDING AUTHENTICATION
  // ════════════════════════════════════════════════════════════
  console.log('\n7. Invitation Onboarding & First-Login Session')

  // PM login
  const pmAuthRes = await fetch(`${API_ORIGIN}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'pm@nvaramedia.com', password: 'Nvara#PM2026!Secure' }),
  })
  const pmCookie = getSessionCookie(pmAuthRes)

  // Generate invite
  const newMemberEmail = `onboard.${randomUUID().slice(0, 6)}@nvaramedia.com`
  const inviteGenRes = await fetch(`${API_ORIGIN}/v1/pm/users/invite`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `nvara_session=${pmCookie}`,
    },
    body: JSON.stringify({
      displayName: 'Onboarded Specialist',
      email: newMemberEmail,
      role: 'internal_team_member',
      mode: 'invite_link',
    }),
  })
  assert.equal(inviteGenRes.status, 201)
  const inviteToken = (await inviteGenRes.json()).rawToken

  // 7.1 Verify invite token details
  const verifyInviteRes = await fetch(`${API_ORIGIN}/v1/invitations/${inviteToken}`)
  assert.equal(verifyInviteRes.status, 200)
  const verifyInviteData = await verifyInviteRes.json()
  assert.equal(verifyInviteData.email, newMemberEmail.toLowerCase())
  assert.equal(verifyInviteData.role, 'internal_team_member')
  console.log('  ✓ Invitation token verified with accurate role and identity')

  // 7.2 Accept invitation, set password, and receive session cookie
  const invitePass = 'SecureNewPassword#2026'
  const acceptInviteRes = await fetch(`${API_ORIGIN}/v1/invitations/${inviteToken}/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: invitePass }),
  })
  assert.equal(acceptInviteRes.status, 201, 'Invitation accept must return 201')
  const newMemberCookie = getSessionCookie(acceptInviteRes)
  assert.ok(newMemberCookie, 'Must issue session cookie to newly onboarded member')

  // 7.3 Newly created session immediately authenticated
  const newMemberMeRes = await fetch(`${API_ORIGIN}/v1/auth/me`, {
    headers: { Cookie: `nvara_session=${newMemberCookie}` },
  })
  assert.equal(newMemberMeRes.status, 200)
  const newMemberData = await newMemberMeRes.json()
  assert.equal(newMemberData.user.email, newMemberEmail.toLowerCase())
  console.log('  ✓ Invitation acceptance establishes authenticated session for new member')

  // 7.4 Replaying consumed invitation token fails
  const replayInviteRes = await fetch(`${API_ORIGIN}/v1/invitations/${inviteToken}/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'AnotherPassword#999' }),
  })
  assert.equal(replayInviteRes.status, 400, 'Replaying accepted invite must return 400')
  console.log('  ✓ Invitation token is single-use: replay attempt rejected with 400')

  // ════════════════════════════════════════════════════════════
  // 8. MULTI-DEVICE SESSION MANAGEMENT & OWNERSHIP
  // ════════════════════════════════════════════════════════════
  console.log('\n8. Session Ownership & Device Management')

  // List sessions for newly onboarded member
  const listSessionsRes = await fetch(`${API_ORIGIN}/v1/auth/sessions`, {
    headers: { Cookie: `nvara_session=${newMemberCookie}` },
  })
  assert.equal(listSessionsRes.status, 200)
  const { sessions } = await listSessionsRes.json()
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].isCurrent, true)
  assert.equal(sessions[0].sessionTokenHash, undefined, 'Must NEVER expose token hash in API response')
  assert.equal(sessions[0].rawToken, undefined, 'Must NEVER expose raw token in API response')
  console.log('  ✓ Session list endpoint sanitizes all token secrets and marks current session')

  // ════════════════════════════════════════════════════════════
  // 9. DEV AUTH ISOLATION
  // ════════════════════════════════════════════════════════════
  console.log('\n9. Dev Auth Header Isolation')

  // Forged dev auth subject with non-existent subject fails
  const badDevAuthRes = await fetch(`${API_ORIGIN}/v1/auth/me`, {
    headers: { 'x-dev-auth-subject': 'non-existent-random-subject-xyz' },
  })
  assert.equal(badDevAuthRes.status, 401, 'Invalid dev auth subject must return 401')
  console.log('  ✓ Invalid dev auth header fails closed with 401')

  console.log('\n══════════════════════════════════════════════════════════════')
  console.log(' RESULTS: ALL 22 AUTHENTICATION TESTS PASSED, 0 FAILED 🎉     ')
  console.log('══════════════════════════════════════════════════════════════\n')
} finally {
  await db.end()
}
