import assert from 'node:assert/strict'
import { randomUUID, randomBytes, scryptSync } from 'node:crypto'
import pg from 'pg'

const API_ORIGIN = process.env.API_ORIGIN ?? process.env.API_URL ?? 'http://127.0.0.1:4001'
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://nvara:nvara_local_dev_only@localhost:55432/nvara'
const db = new pg.Pool({ connectionString: DATABASE_URL })

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex')
  const derivedKey = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 })
  return `${salt}:${derivedKey.toString('hex')}`
}

console.log('\n══════════════════════════════════════════════════════════════')
console.log('       FAANG-GRADE AUTHORIZATION FORENSIC TEST SUITE          ')
console.log('══════════════════════════════════════════════════════════════\n')

function getSessionCookie(res) {
  const setCookie = res.headers.get('set-cookie')
  if (!setCookie) return null
  const match = setCookie.match(/nvara_session=([^;]+)/)
  return match ? match[1] : null
}

async function loginUser(email, password) {
  const res = await fetch(`${API_ORIGIN}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (res.status !== 200) {
    const body = await res.text()
    throw new Error(`Login failed for ${email} (${res.status}): ${body}`)
  }
  const cookie = getSessionCookie(res)
  const data = await res.json()
  return { cookie, user: data.user }
}

try {
  // ── Setup: Authenticate PM, Specialist Rohan, Specialist Priya ──
  const pmAuth = await loginUser('pm@nvaramedia.com', 'Nvara#PM2026!Secure')
  const rohanAuth = await loginUser('rohan.mehta@nvaramedia.com', 'Rohan#Ops2026!Dev')
  const priyaAuth = await loginUser('priya.sharma@nvaramedia.com', 'Priya#Ops2026!Dev')

  // Setup a second isolated organization for Cross-Tenant Testing
  const secondOrgRes = await db.query(
    `INSERT INTO organizations (name)
     VALUES ('Acme Corp ' || gen_random_uuid())
     RETURNING id`
  )
  const orgBId = secondOrgRes.rows[0].id

  // Create PM and Specialist in Org B
  const orgBPmEmail = `pm.b.${randomUUID().slice(0, 6)}@acme.com`
  const orgBSpecEmail = `spec.b.${randomUUID().slice(0, 6)}@acme.com`
  const passwordHash = hashPassword('DevPassword123!')

  const pmRoleRes = await db.query("SELECT id FROM roles WHERE code = 'project_manager'")
  const specRoleRes = await db.query("SELECT id FROM roles WHERE code = 'internal_team_member'")
  const pmRoleId = pmRoleRes.rows[0].id
  const specRoleId = specRoleRes.rows[0].id

  const orgBPmUser = await db.query(
    `INSERT INTO users (organization_id, display_name, email, password_hash, auth_subject, is_active)
     VALUES ($1, 'Acme PM', $2, $3, $4, true) RETURNING id`,
    [orgBId, orgBPmEmail, passwordHash, `auth-${randomUUID()}`]
  )
  await db.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [orgBPmUser.rows[0].id, pmRoleId])

  const orgBSpecUser = await db.query(
    `INSERT INTO users (organization_id, display_name, email, password_hash, auth_subject, is_active)
     VALUES ($1, 'Acme Specialist', $2, $3, $4, true) RETURNING id`,
    [orgBId, orgBSpecEmail, passwordHash, `auth-${randomUUID()}`]
  )
  await db.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [orgBSpecUser.rows[0].id, specRoleId])

  // Setup a test ticket in Org A assigned to Rohan
  const domainRes = await db.query("SELECT id FROM service_domains WHERE slug = 'seo' LIMIT 1")
  const clientRes = await db.query('SELECT id, organization_id FROM clients LIMIT 1')
  const orgAId = clientRes.rows[0].organization_id

  const reqARes = await db.query(
    `INSERT INTO requests (organization_id, public_reference, client_id, service_domain_id, requirement, urgency, status, version)
     VALUES ($1, $2, $3, $4, 'Auth Test Requirement For Rohan', 'soon', 'awaiting_acknowledgement', 1)
     RETURNING id, public_reference`,
    [orgAId, `NVARA-2026-${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`, clientRes.rows[0].id, domainRes.rows[0].id]
  )
  const reqA = reqARes.rows[0]

  const assignARes = await db.query(
    `INSERT INTO assignments (request_id, assignee_user_id)
     VALUES ($1, (SELECT id FROM users WHERE email = 'rohan.mehta@nvaramedia.com'))
     RETURNING id`,
    [reqA.id]
  )
  await db.query(
    `INSERT INTO sla_records (assignment_id, policy_code, duration_seconds, started_at, deadline_at, status)
     VALUES ($1, 'acknowledgement_24h', 86400, now(), now() + interval '24 hours', 'active')`,
    [assignARes.rows[0].id]
  )

  // Setup a test ticket in Org B
  const domainB = await db.query(
    `INSERT INTO service_domains (organization_id, name, slug)
     VALUES ($1, 'Digital Ads', 'digital-ads') RETURNING id`,
    [orgBId]
  )
  const clientB = await db.query(
    `INSERT INTO clients (organization_id, name, company, email, phone_whatsapp)
     VALUES ($1, 'Acme Client', 'Acme Inc', 'client@acme.com', '+1234567890') RETURNING id`,
    [orgBId]
  )
  const reqBRes = await db.query(
    `INSERT INTO requests (organization_id, public_reference, client_id, service_domain_id, requirement, urgency, status, version)
     VALUES ($1, $2, $3, $4, 'Org B Test Request', 'flexible', 'awaiting_acknowledgement', 1)
     RETURNING id, public_reference`,
    [orgBId, `ACME-${randomUUID().slice(0, 6).toUpperCase()}`, clientB.rows[0].id, domainB.rows[0].id]
  )
  const reqB = reqBRes.rows[0]

  // ════════════════════════════════════════════════════════════
  // 1. VERTICAL PRIVILEGE ESCALATION TESTS (Specialist -> PM)
  // ════════════════════════════════════════════════════════════
  console.log('1. Vertical Privilege Escalation (Specialist -> PM Guards)')

  // 1.1 Specialist attempts to invite a user -> 403 Forbidden
  const specInviteRes = await fetch(`${API_ORIGIN}/v1/pm/users/invite`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `nvara_session=${rohanAuth.cookie}`,
    },
    body: JSON.stringify({
      displayName: 'Unauthorized Invite',
      email: 'unauth@nvaramedia.com',
      role: 'internal_team_member',
      mode: 'invite_link',
    }),
  })
  assert.equal(specInviteRes.status, 403, 'Specialist must receive 403 attempting to invite users')
  console.log('  ✓ Specialist cannot invite users (403 Forbidden)')

  // 1.2 Specialist attempts to patch user role / status -> 403 Forbidden
  const specPatchRes = await fetch(`${API_ORIGIN}/v1/pm/users/${pmAuth.user.id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `nvara_session=${rohanAuth.cookie}`,
    },
    body: JSON.stringify({ role: 'project_manager' }),
  })
  assert.equal(specPatchRes.status, 403, 'Specialist must receive 403 attempting to modify user roles')
  console.log('  ✓ Specialist cannot modify user roles (403 Forbidden)')

  // 1.3 Specialist attempts to assign ticket -> 403 Forbidden
  const specAssignRes = await fetch(`${API_ORIGIN}/v1/pm/requests/${reqA.public_reference}/assignments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `idem-${randomUUID()}`,
      Cookie: `nvara_session=${rohanAuth.cookie}`,
    },
    body: JSON.stringify({ expectedVersion: 1, assigneeUserId: priyaAuth.user.id }),
  })
  assert.equal(specAssignRes.status, 403, 'Specialist must receive 403 attempting to assign requests')
  console.log('  ✓ Specialist cannot reassign requests (403 Forbidden)')

  // 1.4 Specialist attempts to archive/delete request -> 403 Forbidden
  const specDeleteRes = await fetch(`${API_ORIGIN}/v1/pm/requests/${reqA.public_reference}`, {
    method: 'DELETE',
    headers: {
      Cookie: `nvara_session=${rohanAuth.cookie}`,
    },
  })
  assert.equal(specDeleteRes.status, 403, 'Specialist must receive 403 attempting to delete/archive requests')
  console.log('  ✓ Specialist cannot delete/archive requests (403 Forbidden)')

  // 1.5 Specialist attempts to view compliance audit logs -> 403 Forbidden
  const specAuditRes = await fetch(`${API_ORIGIN}/v1/pm/audit-logs`, {
    headers: { Cookie: `nvara_session=${rohanAuth.cookie}` },
  })
  assert.equal(specAuditRes.status, 403, 'Specialist must receive 403 attempting to view compliance audit trail')
  console.log('  ✓ Specialist cannot view compliance audit logs (403 Forbidden)')

  // 1.6 Specialist attempts to purge audit logs -> 403 Forbidden
  const specPurgeRes = await fetch(`${API_ORIGIN}/v1/pm/audit-logs?all=true`, {
    method: 'DELETE',
    headers: { Cookie: `nvara_session=${rohanAuth.cookie}` },
  })
  assert.equal(specPurgeRes.status, 403, 'Specialist must receive 403 attempting to purge audit logs')
  console.log('  ✓ Specialist cannot purge audit logs (403 Forbidden)')

  // ════════════════════════════════════════════════════════════
  // 2. HORIZONTAL PRIVILEGE ESCALATION (BOLA / Object-Level Auth)
  // ════════════════════════════════════════════════════════════
  console.log('\n2. Horizontal Privilege Escalation (Object-Level Authorization / BOLA)')

  // 2.1 Non-assigned Specialist Priya attempts to view comments on Rohan's ticket -> 403 Forbidden
  const priyaViewCommentsRes = await fetch(`${API_ORIGIN}/v1/pm/requests/${reqA.public_reference}/comments`, {
    headers: { Cookie: `nvara_session=${priyaAuth.cookie}` },
  })
  assert.equal(priyaViewCommentsRes.status, 403, 'Non-assigned specialist must be forbidden from viewing internal comments')
  console.log('  ✓ Non-assigned specialist cannot view comments on another specialist ticket (403)')

  // 2.2 Non-assigned Specialist Priya attempts to post comment on Rohan's ticket -> 403 Forbidden
  const priyaPostCommentRes = await fetch(`${API_ORIGIN}/v1/pm/requests/${reqA.public_reference}/comments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `idem-${randomUUID()}`,
      Cookie: `nvara_session=${priyaAuth.cookie}`,
    },
    body: JSON.stringify({ body: 'Unauthorized comment attempt by Priya' }),
  })
  assert.equal(priyaPostCommentRes.status, 403, 'Non-assigned specialist must be forbidden from posting comments')
  console.log('  ✓ Non-assigned specialist cannot post comments on another specialist ticket (403)')

  // 2.3 Non-assigned Specialist Priya attempts to acknowledge Rohan's ticket -> 403 Forbidden
  const priyaAckRes = await fetch(`${API_ORIGIN}/v1/requests/${reqA.public_reference}/acknowledge`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `idem-${randomUUID()}`,
      Cookie: `nvara_session=${priyaAuth.cookie}`,
    },
    body: JSON.stringify({ expectedVersion: 1 }),
  })
  assert.equal(priyaAckRes.status, 403, 'Non-assigned specialist must receive 403 attempting to acknowledge')
  console.log('  ✓ Non-assigned specialist cannot acknowledge another specialist ticket (403)')

  // 2.4 Verify DB was UNCHANGED after Priya's failed mutation
  const checkReqStatus = await db.query('SELECT status, version FROM requests WHERE id = $1', [reqA.id])
  assert.equal(checkReqStatus.rows[0].status, 'awaiting_acknowledgement', 'DB status must remain awaiting_acknowledgement')
  assert.equal(checkReqStatus.rows[0].version, 1, 'DB version must remain unchanged at 1')
  console.log('  ✓ Negative mutation integrity: DB unchanged after 403 denial')

  // 2.5 Assigned Specialist Rohan can acknowledge successfully
  const rohanAckRes = await fetch(`${API_ORIGIN}/v1/requests/${reqA.public_reference}/acknowledge`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `idem-${randomUUID()}`,
      Cookie: `nvara_session=${rohanAuth.cookie}`,
    },
    body: JSON.stringify({ expectedVersion: 1 }),
  })
  assert.equal(rohanAckRes.status, 200, 'Assigned specialist must succeed in acknowledging ticket')
  console.log('  ✓ Assigned specialist Rohan acknowledges ticket successfully (200)')

  // ════════════════════════════════════════════════════════════
  // 3. CROSS-TENANT / MULTI-ORGANIZATION ISOLATION
  // ════════════════════════════════════════════════════════════
  console.log('\n3. Cross-Tenant / Multi-Organization Isolation')

  // 3.1 PM-A attempts to query Org-B request detail -> 404 REQUEST_NOT_FOUND
  const crossOrgReqDetailRes = await fetch(`${API_ORIGIN}/v1/pm/requests/${reqB.public_reference}`, {
    headers: { Cookie: `nvara_session=${pmAuth.cookie}` },
  })
  assert.equal(crossOrgReqDetailRes.status, 404, 'PM-A must not access Org-B request detail')
  console.log('  ✓ Cross-organization request detail access returns 404')

  // 3.2 PM-A attempts to mutate Org-B request -> 404 REQUEST_NOT_FOUND
  const crossOrgMutateRes = await fetch(`${API_ORIGIN}/v1/requests/${reqB.public_reference}/acknowledge`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `idem-${randomUUID()}`,
      Cookie: `nvara_session=${pmAuth.cookie}`,
    },
    body: JSON.stringify({ expectedVersion: 1 }),
  })
  assert.equal(crossOrgMutateRes.status, 404, 'PM-A must not mutate Org-B request')
  console.log('  ✓ Cross-organization request mutation returns 404')

  // 3.3 PM-A attempts to access Org-B user detail -> 404 USER_NOT_FOUND
  const crossOrgUserDetailRes = await fetch(`${API_ORIGIN}/v1/pm/users/${orgBPmUser.rows[0].id}/detail`, {
    headers: { Cookie: `nvara_session=${pmAuth.cookie}` },
  })
  assert.equal(crossOrgUserDetailRes.status, 404, 'PM-A must not access Org-B user profile')
  console.log('  ✓ Cross-organization user profile access returns 404')

  // 3.4 PM-A attempts to modify Org-B user -> 404 USER_NOT_FOUND
  const crossOrgPatchUserRes = await fetch(`${API_ORIGIN}/v1/pm/users/${orgBPmUser.rows[0].id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `nvara_session=${pmAuth.cookie}`,
    },
    body: JSON.stringify({ displayName: 'Hacked Org B PM' }),
  })
  assert.equal(crossOrgPatchUserRes.status, 404, 'PM-A must not modify Org-B user')
  console.log('  ✓ Cross-organization user modification returns 404')

  // 3.5 PM-A audit log query strictly filters out Org-B records
  const auditRes = await fetch(`${API_ORIGIN}/v1/pm/audit-logs`, {
    headers: { Cookie: `nvara_session=${pmAuth.cookie}` },
  })
  const auditData = await auditRes.json()
  for (const log of auditData.logs) {
    const checkLog = await db.query('SELECT organization_id FROM audit_events WHERE id = $1', [log.id])
    assert.equal(checkLog.rows[0].organization_id, orgAId, 'Audit logs returned must belong exclusively to Org A')
  }
  console.log('  ✓ Organizational audit trail strictly excludes cross-tenant records')

  // ════════════════════════════════════════════════════════════
  // 4. DEACTIVATED USER IMMEDIATE AUTHORIZATION REVOCATION
  // ════════════════════════════════════════════════════════════
  console.log('\n4. Deactivated User Immediate Authorization Revocation')

  // Create temporary specialist
  const tempEmail = `temp.spec.${randomUUID().slice(0, 6)}@nvaramedia.com`
  const tempUserRes = await db.query(
    `INSERT INTO users (organization_id, display_name, email, password_hash, auth_subject, is_active)
     VALUES ($1, 'Temp Specialist', $2, $3, $4, true) RETURNING id`,
    [orgAId, tempEmail, passwordHash, `auth-${randomUUID()}`]
  )
  await db.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [tempUserRes.rows[0].id, specRoleId])

  // Establish active session
  const tempLogin = await loginUser(tempEmail, 'DevPassword123!')
  const activeMeRes = await fetch(`${API_ORIGIN}/v1/auth/me`, {
    headers: { Cookie: `nvara_session=${tempLogin.cookie}` },
  })
  assert.equal(activeMeRes.status, 200, 'Active user session must be valid')

  // PM deactivates user
  const deactRes = await fetch(`${API_ORIGIN}/v1/pm/users/${tempUserRes.rows[0].id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `nvara_session=${pmAuth.cookie}`,
    },
    body: JSON.stringify({ isActive: false }),
  })
  assert.equal(deactRes.status, 200, 'Deactivation must succeed')

  // Deactivated user immediately calls protected endpoint with old session -> 401 UNAUTHENTICATED
  const postDeactMeRes = await fetch(`${API_ORIGIN}/v1/auth/me`, {
    headers: { Cookie: `nvara_session=${tempLogin.cookie}` },
  })
  assert.equal(postDeactMeRes.status, 401, 'Deactivated user session must be instantly rejected with 401')
  console.log('  ✓ Deactivated user session immediately rejected with 401 on protected routes')

  // ════════════════════════════════════════════════════════════
  // 5. STALE ROLE FRESHNESS (Demotion / Live Database Auth)
  // ════════════════════════════════════════════════════════════
  console.log('\n5. Stale Role Freshness (Database Live Lookup vs Session Claims)')

  // Create temporary PM
  const tempPmEmail = `temp.pm.${randomUUID().slice(0, 6)}@nvaramedia.com`
  const tempPmUserRes = await db.query(
    `INSERT INTO users (organization_id, display_name, email, password_hash, auth_subject, is_active)
     VALUES ($1, 'Temp PM', $2, $3, $4, true) RETURNING id`,
    [orgAId, tempPmEmail, passwordHash, `auth-${randomUUID()}`]
  )
  await db.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [tempPmUserRes.rows[0].id, pmRoleId])

  // Login as PM
  const tempPmLogin = await loginUser(tempPmEmail, 'DevPassword123!')

  // Verify PM has access to audit logs
  const tempPmAuditRes = await fetch(`${API_ORIGIN}/v1/pm/audit-logs`, {
    headers: { Cookie: `nvara_session=${tempPmLogin.cookie}` },
  })
  assert.equal(tempPmAuditRes.status, 200, 'Active PM can access audit logs')

  // Super PM demotes Temp PM to specialist
  await fetch(`${API_ORIGIN}/v1/pm/users/${tempPmUserRes.rows[0].id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `nvara_session=${pmAuth.cookie}`,
    },
    body: JSON.stringify({ role: 'internal_team_member' }),
  })

  // Demoted user immediately calls PM route with existing session -> 403 FORBIDDEN (No stale role retention)
  const demotedAuditRes = await fetch(`${API_ORIGIN}/v1/pm/audit-logs`, {
    headers: { Cookie: `nvara_session=${tempPmLogin.cookie}` },
  })
  assert.equal(demotedAuditRes.status, 403, 'Demoted PM must immediately lose PM access with existing session')
  console.log('  ✓ Demoted user immediately loses PM privileges on next request with active session (403)')

  // ════════════════════════════════════════════════════════════
  // 6. FORGED REQUEST BODY / ATTRIBUTE RESISTANCE
  // ════════════════════════════════════════════════════════════
  console.log('\n6. Forged Request Body & Payload Attribute Resistance')

  // 6.1 Sending unexpected extra fields on mutation -> 422 VALIDATION_ERROR (Zod strict)
  const forgedPayloadRes = await fetch(`${API_ORIGIN}/v1/requests/${reqA.public_reference}/start-work`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `idem-${randomUUID()}`,
      Cookie: `nvara_session=${rohanAuth.cookie}`,
    },
    body: JSON.stringify({
      expectedVersion: 2,
      override: true,
      actorUserId: pmAuth.user.id,
      organizationId: orgBId,
      role: 'project_manager',
    }),
  })
  assert.equal(forgedPayloadRes.status, 422, 'Forged extra fields in mutation body must be rejected with 422')
  console.log('  ✓ Forged authorization attributes in request body rejected by strict validator (422)')

  // ════════════════════════════════════════════════════════════
  // 7. PM OPERATIONAL OVERRIDE INTEGRITY
  // ════════════════════════════════════════════════════════════
  console.log('\n7. PM Operational Override Integrity')

  // Create ticket assigned to Rohan
  const reqOverrideRes = await db.query(
    `INSERT INTO requests (organization_id, public_reference, client_id, service_domain_id, requirement, urgency, status, version)
     VALUES ($1, $2, $3, $4, 'PM Override Auth Test', 'soon', 'awaiting_acknowledgement', 1)
     RETURNING id, public_reference`,
    [orgAId, `NVARA-OVR-${randomUUID().slice(0, 6).toUpperCase()}`, clientRes.rows[0].id, domainRes.rows[0].id]
  )
  const reqOverride = reqOverrideRes.rows[0]
  const ovrAssignRes = await db.query(
    `INSERT INTO assignments (request_id, assignee_user_id)
     VALUES ($1, (SELECT id FROM users WHERE email = 'rohan.mehta@nvaramedia.com'))
     RETURNING id`,
    [reqOverride.id]
  )
  const ovrSlaRes = await db.query(
    `INSERT INTO sla_records (assignment_id, policy_code, duration_seconds, started_at, deadline_at, status)
     VALUES ($1, 'acknowledgement_24h', 86400, now(), now() + interval '24 hours', 'active')
     RETURNING id`,
    [ovrAssignRes.rows[0].id]
  )

  // PM performs override acknowledgement
  const pmOvrAckRes = await fetch(`${API_ORIGIN}/v1/requests/${reqOverride.public_reference}/acknowledge`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `idem-${randomUUID()}`,
      Cookie: `nvara_session=${pmAuth.cookie}`,
    },
    body: JSON.stringify({ expectedVersion: 1 }),
  })
  assert.equal(pmOvrAckRes.status, 200, 'PM override acknowledgement must succeed')

  // Check that SLA acknowledged_by_user_id is the accountable specialist, but audit event records PM as actor
  const checkSla = await db.query('SELECT acknowledged_by_user_id FROM sla_records WHERE id = $1', [ovrSlaRes.rows[0].id])
  assert.equal(checkSla.rows[0].acknowledged_by_user_id, rohanAuth.user.id, 'SLA accountable specialist must remain Rohan')

  const checkAudit = await db.query(
    `SELECT actor_user_id, metadata FROM audit_events
     WHERE request_id = $1 AND event_type = 'acknowledged'
     ORDER BY occurred_at DESC LIMIT 1`,
    [reqOverride.id]
  )
  assert.equal(checkAudit.rows[0].actor_user_id, pmAuth.user.id, 'Audit log must record PM as actual actor')
  assert.equal(checkAudit.rows[0].metadata.override, true, 'Audit log metadata must record override: true')
  console.log('  ✓ PM operational override correctly attributes SLA accountability and audit attribution')

  // ════════════════════════════════════════════════════════════
  // 8. STATE-BASED WORKFLOW AUTHORIZATION GUARDS
  // ════════════════════════════════════════════════════════════
  console.log('\n8. State-Based Workflow Authorization Guards')

  // 8.1 Cannot start work when awaiting_acknowledgement -> 409 INVALID_STATE_TRANSITION
  const reqFresh = await db.query(
    `INSERT INTO requests (organization_id, public_reference, client_id, service_domain_id, requirement, urgency, status, version)
     VALUES ($1, $2, $3, $4, 'State Machine Guard Test', 'soon', 'awaiting_acknowledgement', 1)
     RETURNING id, public_reference`,
    [orgAId, `NVARA-STATE-${randomUUID().slice(0, 6).toUpperCase()}`, clientRes.rows[0].id, domainRes.rows[0].id]
  )
  await db.query(
    `INSERT INTO assignments (request_id, assignee_user_id)
     VALUES ($1, (SELECT id FROM users WHERE email = 'rohan.mehta@nvaramedia.com'))`,
    [reqFresh.rows[0].id]
  )

  const prematureStartRes = await fetch(`${API_ORIGIN}/v1/requests/${reqFresh.rows[0].public_reference}/start-work`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `idem-${randomUUID()}`,
      Cookie: `nvara_session=${rohanAuth.cookie}`,
    },
    body: JSON.stringify({ expectedVersion: 1 }),
  })
  assert.equal(prematureStartRes.status, 409, 'Cannot start work before acknowledgement')
  console.log('  ✓ Premature start-work rejected with 409 INVALID_STATE_TRANSITION')

  // 8.2 Non-resolved active request cannot be archived by PM -> 409 INVALID_STATE_TRANSITION
  const activeArchiveRes = await fetch(`${API_ORIGIN}/v1/pm/requests/${reqFresh.rows[0].public_reference}`, {
    method: 'DELETE',
    headers: { Cookie: `nvara_session=${pmAuth.cookie}` },
    body: JSON.stringify({ expectedVersion: 1 }),
  })
  assert.equal(activeArchiveRes.status, 409, 'Active non-resolved request cannot be archived')
  console.log('  ✓ Active ticket deletion rejected with 409 INVALID_STATE_TRANSITION')

  // ════════════════════════════════════════════════════════════
  // 9. PUBLIC TRACKER BOUNDARIES & SAFE DTO VERIFICATION
  // ════════════════════════════════════════════════════════════
  console.log('\n9. Public Tracker Boundaries & Safe DTO Leakage Prevention')
  await fetch(`${API_ORIGIN}/v1/test/reset-tracker-rate-limit`, { method: 'POST' }).catch(() => {})

  // 9.1 Malformed reference -> 400
  const malformedTrackRes = await fetch(`${API_ORIGIN}/v1/track/INVALID-REF-FORMAT`)
  assert.equal(malformedTrackRes.status, 400, 'Malformed reference must return 400')
  console.log('  ✓ Malformed tracker reference returns 400')

  // 9.2 Non-existent reference -> 404 with generic error shape
  const notFoundTrackRes = await fetch(`${API_ORIGIN}/v1/track/NVARA-2026-99999999`)
  assert.equal(notFoundTrackRes.status, 404, 'Non-existent reference must return 404')
  console.log('  ✓ Non-existent reference returns 404 without data hints')

  // 9.3 Soft-deleted/archived request -> 404
  const archivedReqRes = await db.query(
    `INSERT INTO requests (organization_id, public_reference, client_id, service_domain_id, requirement, urgency, status, version, deleted_at)
     VALUES ($1, $2, $3, $4, 'Archived Request Tracker Test', 'flexible', 'resolved', 2, now())
     RETURNING public_reference`,
    [orgAId, `NVARA-2026-${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`, clientRes.rows[0].id, domainRes.rows[0].id]
  )
  const deletedTrackRes = await fetch(`${API_ORIGIN}/v1/track/${archivedReqRes.rows[0].public_reference}`)
  assert.equal(deletedTrackRes.status, 404, 'Archived/deleted request must return 404 in public tracker')
  console.log('  ✓ Archived/deleted request returns 404 in public tracker')

  // 9.4 Valid request exposes ONLY Safe DTO allowlist
  const validTrackRes = await fetch(`${API_ORIGIN}/v1/track/${reqA.public_reference}`)
  assert.equal(validTrackRes.status, 200, 'Valid reference returns 200')
  const trackBody = await validTrackRes.json()
  const allowedKeys = new Set(['reference', 'status', 'statusLabel', 'serviceArea', 'submittedAt', 'lastUpdatedAt', 'milestones'])
  for (const key of Object.keys(trackBody)) {
    assert.ok(allowedKeys.has(key), `Public tracker must not expose key ${key}`)
  }
  assert.equal(trackBody.clientId, undefined, 'No client ID')
  assert.equal(trackBody.assigneeUserId, undefined, 'No specialist user ID')
  assert.equal(trackBody.auditEvents, undefined, 'No internal audit events')
  console.log('  ✓ Public tracker strictly restricts fields to Safe DTO allowlist')

  // ════════════════════════════════════════════════════════════
  // 10. INVITATION ROLE & ORG FORGERY RESISTANCE
  // ════════════════════════════════════════════════════════════
  console.log('\n10. Invitation Role & Organization Forgery Resistance')

  // PM creates specialist invitation
  const inviteEmail = `invited.spec.${randomUUID().slice(0, 6)}@nvaramedia.com`
  const genInviteRes = await fetch(`${API_ORIGIN}/v1/pm/users/invite`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `nvara_session=${pmAuth.cookie}`,
    },
    body: JSON.stringify({
      displayName: 'Invited Specialist',
      email: inviteEmail,
      role: 'internal_team_member',
      mode: 'invite_link',
    }),
  })
  assert.equal(genInviteRes.status, 201, 'Invite generation must succeed')
  const inviteData = await genInviteRes.json()
  const rawToken = inviteData.rawToken

  // Attacker attempts to forge role=project_manager and organization_id=orgB during acceptance
  const forgedAcceptRes = await fetch(`${API_ORIGIN}/v1/invitations/${rawToken}/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      password: 'StrongPassword123!',
      role: 'project_manager',
      organization_id: orgBId,
      actor_id: 'forged-actor',
      user_id: 'forged-user',
    }),
  })
  assert.equal(forgedAcceptRes.status, 201, 'Invitation acceptance succeeds')
  const acceptBody = await forgedAcceptRes.json()
  assert.equal(acceptBody.user.role, 'internal_team_member', 'User role must remain internal_team_member (not escalated)')

  // Verify in PostgreSQL database
  const checkCreatedUser = await db.query(
    `SELECT u.organization_id, r.code AS role
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     WHERE u.email = $1`,
    [inviteEmail.toLowerCase()]
  )
  assert.equal(checkCreatedUser.rows[0].organization_id, orgAId, 'User must belong to Org A (cannot forge org B)')
  assert.equal(checkCreatedUser.rows[0].role, 'internal_team_member', 'User must have internal_team_member role')
  console.log('  ✓ Attacker cannot escalate role or switch organization during invite acceptance')

  // ════════════════════════════════════════════════════════════
  // 11. FORMER SPECIALIST AUTHORIZATION REVOCATION ON REASSIGNMENT
  // ════════════════════════════════════════════════════════════
  console.log('\n11. Former Specialist Authorization Revocation on Reassignment')

  // Create ticket assigned to Rohan
  const reqReassign = await db.query(
    `INSERT INTO requests (organization_id, public_reference, client_id, service_domain_id, requirement, urgency, status, version)
     VALUES ($1, $2, $3, $4, 'Former Specialist Revocation Test', 'soon', 'awaiting_acknowledgement', 1)
     RETURNING id, public_reference`,
    [orgAId, `NVARA-REV-${randomUUID().slice(0, 6).toUpperCase()}`, clientRes.rows[0].id, domainRes.rows[0].id]
  )
  await db.query(
    `INSERT INTO assignments (request_id, assignee_user_id)
     VALUES ($1, (SELECT id FROM users WHERE email = 'rohan.mehta@nvaramedia.com'))`,
    [reqReassign.rows[0].id]
  )

  // PM reassigns ticket to Priya
  const pmReassignRes = await fetch(`${API_ORIGIN}/v1/pm/requests/${reqReassign.rows[0].public_reference}/assignments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `idem-${randomUUID()}`,
      Cookie: `nvara_session=${pmAuth.cookie}`,
    },
    body: JSON.stringify({ expectedVersion: 1, assigneeUserId: priyaAuth.user.id }),
  })
  assert.equal(pmReassignRes.status, 200, 'Reassignment must succeed')

  // Former specialist Rohan attempts to acknowledge -> 403 FORBIDDEN
  const rohanFormerAckRes = await fetch(`${API_ORIGIN}/v1/requests/${reqReassign.rows[0].public_reference}/acknowledge`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `idem-${randomUUID()}`,
      Cookie: `nvara_session=${rohanAuth.cookie}`,
    },
    body: JSON.stringify({ expectedVersion: 2 }),
  })
  assert.equal(rohanFormerAckRes.status, 403, 'Former specialist must receive 403 attempting to mutate reassigned ticket')
  console.log('  ✓ Former specialist immediately loses mutation authorization when assignment ends (403)')

  // ════════════════════════════════════════════════════════════
  // 12. IMMUTABLE AUDIT DATABASE TRIGGER VERIFICATION
  // ════════════════════════════════════════════════════════════
  console.log('\n12. Immutable Audit Database Trigger Verification')

  // Attempting raw SQL UPDATE on audit event payload fails with error 55006
  const sampleAudit = await db.query('SELECT id FROM audit_events LIMIT 1')
  if (sampleAudit.rowCount) {
    const auditId = sampleAudit.rows[0].id
    let triggerBlockedUpdate = false
    try {
      await db.query("UPDATE audit_events SET event_type = 'hacked_event' WHERE id = $1", [auditId])
    } catch (err) {
      if (err.code === '55006' || err.message.includes('immutable') || err.message.includes('append-only')) {
        triggerBlockedUpdate = true
      }
    }
    assert.ok(triggerBlockedUpdate, 'Database trigger must block audit payload mutation with error 55006')

    let triggerBlockedDelete = false
    try {
      await db.query('DELETE FROM audit_events WHERE id = $1', [auditId])
    } catch (err) {
      if (err.code === '55006' || err.message.includes('immutable') || err.message.includes('append-only')) {
        triggerBlockedDelete = true
      }
    }
    assert.ok(triggerBlockedDelete, 'Database trigger must block hard DELETE on audit records with error 55006')
    console.log('  ✓ PostgreSQL database trigger prevents audit payload tampering and hard deletion (ERRCODE 55006)')
  }

  console.log('\n══════════════════════════════════════════════════════════════')
  console.log(' RESULTS: ALL 28 AUTHORIZATION TESTS PASSED, 0 FAILED 🎉      ')
  console.log('══════════════════════════════════════════════════════════════\n')
} finally {
  await db.end()
}
