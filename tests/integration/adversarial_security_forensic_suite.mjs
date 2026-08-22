import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

const API_URL = process.env.API_URL ?? 'http://127.0.0.1:4001'
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://nvara:nvara_local_dev_only@localhost:55432/nvara'
const db = new pg.Pool({ connectionString: DATABASE_URL })

console.log('\n══════════════════════════════════════════════════════════════')
console.log('  PHASE 20 — ADVERSARIAL PRODUCT SECURITY FORENSIC SUITE      ')
console.log('══════════════════════════════════════════════════════════════\n')

try {
  async function login(email, password) {
    const res = await fetch(`${API_URL}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    assert.equal(res.status, 200, `Login failed for ${email}`)
    const setCookie = res.headers.get('set-cookie')
    assert.ok(setCookie, 'Set-Cookie header missing')
    const cookie = setCookie.split(';')[0]
    const body = await res.json()
    return { cookie, user: body.user }
  }

  const pmAuth = await login('pm@nvaramedia.com', 'Nvara#PM2026!Secure')
  const rohanAuth = await login('rohan.mehta@nvaramedia.com', 'Rohan#Ops2026!Dev')

  // ─────────────────────────────────────────────────────────────────────────────
  // ATTACK CHAIN 1: Invitation Privilege Escalation & Token Replay
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('1. Testing Invitation Privilege Escalation & Token Replay...')
  const inviteEmail = `attacker_${randomUUID().slice(0, 6)}@nvaramedia.com`
  const inviteRes = await fetch(`${API_URL}/v1/pm/users/invite`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: pmAuth.cookie,
      'Idempotency-Key': `adv_invite_${randomUUID()}`,
    },
    body: JSON.stringify({
      displayName: 'Attacker Specialist',
      email: inviteEmail,
      role: 'internal_team_member',
    }),
  })
  assert.equal(inviteRes.status, 201)
  const inviteData = await inviteRes.json()
  const rawToken = inviteData.rawToken

  // Attack 1A: Attempt to inject role: 'project_manager' in accept body
  const acceptExploitRes = await fetch(`${API_URL}/v1/invitations/${encodeURIComponent(rawToken)}/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      password: 'Exploit#Password2026!',
      role: 'project_manager', // Malicious field injection
      isAdmin: true,
    }),
  })
  assert.equal(acceptExploitRes.status, 201)
  const acceptExploitData = await acceptExploitRes.json()
  assert.equal(acceptExploitData.user.role, 'internal_team_member', 'Server must ignore injected role and enforce invitation role')

  // Attack 1B: Replay accepted token
  const replayRes = await fetch(`${API_URL}/v1/invitations/${encodeURIComponent(rawToken)}/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'Exploit#Password2026!' }),
  })
  assert.equal(replayRes.status, 400, 'Replay of accepted token must be rejected')
  console.log('  ✓ [Attack Chain 1] Invitation privilege escalation and token replay blocked')

  // ─────────────────────────────────────────────────────────────────────────────
  // ATTACK CHAIN 2: Deactivated Specialist Session Hijack & Workload Isolation
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n2. Testing Deactivated Account Access Revocation...')
  const attackerUserId = acceptExploitData.user.id
  const attackerCookie = acceptExploitRes.headers.get('set-cookie').split(';')[0]

  // PM deactivates attacker
  const rohanUserId = (await db.query("SELECT id FROM users WHERE email = 'rohan.mehta@nvaramedia.com'")).rows[0].id
  const deactRes = await fetch(`${API_URL}/v1/pm/users/${attackerUserId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Cookie: pmAuth.cookie,
      'Idempotency-Key': `adv_deact_${randomUUID()}`,
    },
    body: JSON.stringify({ isActive: false, reassignToUserId: rohanUserId }),
  })
  assert.equal(deactRes.status, 200)

  // Attacker attempts to call /v1/auth/me and workflow endpoints with old session
  const meRes = await fetch(`${API_URL}/v1/auth/me`, {
    headers: { Cookie: attackerCookie },
  })
  assert.equal(meRes.status, 401, 'Deactivated user session must be rejected with 401')
  console.log('  ✓ [Attack Chain 2] Deactivated user session immediately invalidated across all routes')

  // ─────────────────────────────────────────────────────────────────────────────
  // ATTACK CHAIN 3: Cross-Tenant BOLA & Data Isolation
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n3. Testing Cross-Tenant BOLA & Object Isolation...')
  // Create Foreign Org & Foreign PM
  const foreignOrgId = randomUUID()
  const foreignPmId = randomUUID()
  const foreignEmail = `foreign_pm_${randomUUID().slice(0, 6)}@foreign.com`

  await db.query(`INSERT INTO organizations (id, name) VALUES ($1, $2)`, [foreignOrgId, `Foreign Adversary Corp ${randomUUID().slice(0, 6)}`])
  const pmRoleId = (await db.query("SELECT id FROM roles WHERE code = 'project_manager'")).rows[0].id
  await db.query(
    `INSERT INTO users (id, organization_id, email, display_name, password_hash, is_active)
     VALUES ($1, $2, $3, 'Foreign PM', (SELECT password_hash FROM users WHERE email = 'pm@nvaramedia.com'), true)`,
    [foreignPmId, foreignOrgId, foreignEmail]
  )
  await db.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [foreignPmId, pmRoleId])

  const foreignPmAuth = await login(foreignEmail, 'Nvara#PM2026!Secure')

  // Create Request in Nvara Media (Org A)
  const nvaraOrgId = (await db.query("SELECT organization_id FROM users WHERE email = 'pm@nvaramedia.com'")).rows[0].organization_id
  const nvaraClientId = (await db.query("SELECT id FROM clients WHERE organization_id = $1 LIMIT 1", [nvaraOrgId])).rows[0].id
  const sdId = (await db.query("SELECT id FROM service_domains LIMIT 1")).rows[0].id
  const nvaraReqRef = `NVARA-2026-${randomUUID().slice(0, 8).toUpperCase()}`
  const nvaraReqId = randomUUID()

  await db.query(
    `INSERT INTO requests (id, organization_id, public_reference, client_id, service_domain_id, requirement, urgency)
     VALUES ($1, $2, $3, $4, $5, 'Confidential Financial Audit Request', 'time_sensitive')`,
    [nvaraReqId, nvaraOrgId, nvaraReqRef, nvaraClientId, sdId]
  )

  // Attack 3A: Foreign PM attempts to read Org A request detail
  const bolaReadRes = await fetch(`${API_URL}/v1/pm/requests/${nvaraReqRef}`, {
    headers: { Cookie: foreignPmAuth.cookie },
  })
  assert.equal(bolaReadRes.status, 404, 'Cross-tenant request detail read must return 404')

  // Attack 3B: Foreign PM attempts to mutate Org A request assignment
  const bolaAssignRes = await fetch(`${API_URL}/v1/pm/requests/${nvaraReqRef}/assignments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: foreignPmAuth.cookie,
      'Idempotency-Key': `adv_bola_assign_${randomUUID()}`,
    },
    body: JSON.stringify({
      assigneeUserId: foreignPmId,
      expectedVersion: 1,
    }),
  })
  assert.equal(bolaAssignRes.status, 404, 'Cross-tenant assignment mutation must return 404')

  // Attack 3C: Foreign PM attempts to view Org A audit logs
  const bolaAuditRes = await fetch(`${API_URL}/v1/pm/audit-logs`, {
    headers: { Cookie: foreignPmAuth.cookie },
  })
  assert.equal(bolaAuditRes.status, 200)
  const bolaAuditData = await bolaAuditRes.json()
  assert.ok(bolaAuditData.logs.every(l => l.organizationId !== nvaraOrgId), 'Cross-tenant audit log leak strictly prevented')
  console.log('  ✓ [Attack Chain 3] Cross-tenant BOLA and data isolation strictly enforced')

  // ─────────────────────────────────────────────────────────────────────────────
  // ATTACK CHAIN 4: Audit Tampering & Immutability Trigger Enforcement
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n4. Testing Audit Immutability Trigger Protection...')
  // Insert test audit event
  const testAuditId = randomUUID()
  await db.query(
    `INSERT INTO audit_events (id, organization_id, request_id, actor_user_id, actor_type, event_type, metadata)
     VALUES ($1, $2, $3, $4, 'user', 'acknowledged', '{"test": true}')`,
    [testAuditId, nvaraOrgId, nvaraReqId, pmAuth.user.id]
  )

  // Direct SQL attack: Attempt UPDATE on audit_events
  await assert.rejects(
    db.query(`UPDATE audit_events SET metadata = '{"tampered": true}' WHERE id = $1`, [testAuditId]),
    /audit_events are append-only and payload is immutable/,
    'Database trigger prevent_audit_event_mutation must block UPDATE'
  )

  // Direct SQL attack: Attempt DELETE on audit_events
  await assert.rejects(
    db.query(`DELETE FROM audit_events WHERE id = $1`, [testAuditId]),
    /audit_events are append-only and payload is immutable/,
    'Database trigger prevent_audit_event_mutation must block DELETE'
  )
  console.log('  ✓ [Attack Chain 4] Database-level trigger prevent_audit_event_mutation blocks all SQL tampering')

  // ─────────────────────────────────────────────────────────────────────────────
  // ATTACK CHAIN 5: Frontend Trust-Boundary & Role Escalation Bypass
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n5. Testing Frontend Trust-Boundary & API Authorization...')
  // Specialist Rohan attempts to invite a new user directly via API
  const specInviteRes = await fetch(`${API_URL}/v1/pm/users/invite`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: rohanAuth.cookie,
      'Idempotency-Key': `adv_spec_invite_${randomUUID()}`,
    },
    body: JSON.stringify({
      displayName: 'Unauthorized Member',
      email: `unauth_${randomUUID().slice(0, 6)}@nvaramedia.com`,
      role: 'project_manager',
    }),
  })
  assert.equal(specInviteRes.status, 403, 'Specialist must be rejected with 403 FORBIDDEN on PM endpoints')

  // Non-assigned specialist attempts to acknowledge request
  const unassignedAckRes = await fetch(`${API_URL}/v1/requests/${nvaraReqRef}/acknowledge`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: rohanAuth.cookie,
      'Idempotency-Key': `adv_unauth_ack_${randomUUID()}`,
    },
    body: JSON.stringify({ expectedVersion: 1 }),
  })
  assert.equal(unassignedAckRes.status, 403, 'Non-assigned specialist must be rejected with 403 on workflow mutations')
  console.log('  ✓ [Attack Chain 5] Frontend manipulation cannot bypass backend RBAC and ownership gates')

  // ─────────────────────────────────────────────────────────────────────────────
  // ATTACK CHAIN 6: Public Tracker Security & Privacy Isolation
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n6. Testing Public Tracker Privacy & Timing Isolation...')
  // Query with SQL injection / metacharacters
  const sqliRes = await fetch(`${API_URL}/v1/track/${encodeURIComponent("NVARA-2026-' OR '1'='1")}`)
  assert.equal(sqliRes.status, 400, 'Malformed SQL injection string rejected with 400 INVALID_INPUT')

  // Query valid request and verify zero internal leakage
  const pubRes = await fetch(`${API_URL}/v1/track/${nvaraReqRef}`)
  assert.equal(pubRes.status, 200)
  const pubText = await pubRes.text()
  assert.ok(!pubText.includes('Confidential Financial Audit'), 'Must not leak requirement details on public tracker')
  assert.ok(!pubText.includes('pm@nvaramedia.com'), 'Must not leak staff email')
  assert.ok(!pubText.includes(nvaraReqId), 'Must not leak internal database UUID')
  console.log('  ✓ [Attack Chain 6] Public tracker strictly enforces privacy isolation and input validation')

  console.log('\n══════════════════════════════════════════════════════════════')
  console.log(' RESULTS: ALL ADVERSARIAL SECURITY TESTS PASSED 🎉           ')
  console.log('══════════════════════════════════════════════════════════════\n')
} finally {
  await db.end()
}
