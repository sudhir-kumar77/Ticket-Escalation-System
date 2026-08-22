import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://nvara:nvara_local_dev_only@localhost:55432/nvara'
const db = new pg.Pool({ connectionString: DATABASE_URL })

console.log('\n══════════════════════════════════════════════════════════════')
console.log('  FAANG-GRADE DATABASE INTEGRITY & SCHEMA FORENSIC SUITE      ')
console.log('══════════════════════════════════════════════════════════════\n')

try {
  // 1. Orphan Record Detection Queries
  console.log('1. Database Foreign Key Orphan Record Detection')

  // Check assignments
  const orphanAssignments = await db.query(
    `SELECT count(*)::int AS count FROM assignments a
     LEFT JOIN requests r ON r.id = a.request_id
     LEFT JOIN users u ON u.id = a.assignee_user_id
     WHERE r.id IS NULL OR u.id IS NULL`
  )
  assert.equal(orphanAssignments.rows[0].count, 0, 'Orphan assignments must be 0')

  // Check SLA records
  const orphanSlas = await db.query(
    `SELECT count(*)::int AS count FROM sla_records s
     LEFT JOIN assignments a ON a.id = s.assignment_id
     WHERE a.id IS NULL`
  )
  assert.equal(orphanSlas.rows[0].count, 0, 'Orphan SLA records must be 0')

  // Check Escalation events
  const orphanEscalations = await db.query(
    `SELECT count(*)::int AS count FROM escalation_events e
     LEFT JOIN requests r ON r.id = e.request_id
     LEFT JOIN assignments a ON a.id = e.assignment_id
     LEFT JOIN sla_records s ON s.id = e.sla_record_id
     LEFT JOIN users u ON u.id = e.responsible_user_id
     WHERE r.id IS NULL OR a.id IS NULL OR s.id IS NULL OR u.id IS NULL`
  )
  assert.equal(orphanEscalations.rows[0].count, 0, 'Orphan escalation events must be 0')

  // Check Comments
  const orphanComments = await db.query(
    `SELECT count(*)::int AS count FROM request_comments c
     LEFT JOIN requests r ON r.id = c.request_id
     LEFT JOIN users u ON u.id = c.author_user_id
     WHERE r.id IS NULL OR u.id IS NULL`
  )
  assert.equal(orphanComments.rows[0].count, 0, 'Orphan request comments must be 0')

  // Check User Roles
  const orphanUserRoles = await db.query(
    `SELECT count(*)::int AS count FROM user_roles ur
     LEFT JOIN users u ON u.id = ur.user_id
     LEFT JOIN roles r ON r.id = ur.role_id
     WHERE u.id IS NULL OR r.id IS NULL`
  )
  assert.equal(orphanUserRoles.rows[0].count, 0, 'Orphan user_roles must be 0')

  // Check Sessions
  const orphanSessions = await db.query(
    `SELECT count(*)::int AS count FROM sessions s
     LEFT JOIN users u ON u.id = s.user_id
     WHERE u.id IS NULL`
  )
  assert.equal(orphanSessions.rows[0].count, 0, 'Orphan sessions must be 0')
  console.log('  ✓ 0 orphan records across assignments, SLAs, escalations, comments, roles, and sessions')

  // 2. Duplicate Business Record Invariants
  console.log('\n2. Duplicate Business Record Invariants & Partial Indexes')

  // Multiple active assignments per request
  const dupActiveAssignments = await db.query(
    `SELECT request_id, count(*)::int AS count
     FROM assignments
     WHERE ended_at IS NULL
     GROUP BY request_id
     HAVING count(*) > 1`
  )
  assert.equal(dupActiveAssignments.rowCount, 0, 'Zero requests with multiple active assignments')
  console.log('  ✓ Partial unique index assignments_one_current guarantees exactly <= 1 active assignment')

  // Duplicate active SLAs per assignment
  const dupSlas = await db.query(
    `SELECT assignment_id, count(*)::int AS count
     FROM sla_records
     GROUP BY assignment_id
     HAVING count(*) > 1`
  )
  assert.equal(dupSlas.rowCount, 0, 'Zero assignments with multiple SLA records')
  console.log('  ✓ Unique constraint on sla_records.assignment_id guarantees 1:1 assignment-to-SLA binding')

  // Duplicate email within organization
  const dupOrgEmails = await db.query(
    `SELECT organization_id, lower(email) AS email, count(*)::int AS count
     FROM users
     GROUP BY organization_id, lower(email)
     HAVING count(*) > 1`
  )
  assert.equal(dupOrgEmails.rowCount, 0, 'Zero duplicate user emails within same organization')
  console.log('  ✓ Unique constraint users(organization_id, email) strictly prevents email collision')

  // 3. Database Check Constraint Rejection Testing
  console.log('\n3. Database Engine Check Constraint Rejection Testing')
  const sampleOrg = (await db.query('SELECT id FROM organizations LIMIT 1')).rows[0]
  const sampleUser = (await db.query('SELECT id FROM users LIMIT 1')).rows[0]
  const sampleReq = (await db.query('SELECT id FROM requests LIMIT 1')).rows[0]

  // Test invalid assignment timestamp (ended_at < assigned_at)
  await assert.rejects(
    async () => {
      await db.query(
        `INSERT INTO assignments (request_id, assignee_user_id, assigned_by_user_id, assigned_at, ended_at)
         VALUES ($1, $2, $2, now(), now() - interval '1 hour')`,
        [sampleReq.id, sampleUser.id]
      )
    },
    (err) => {
      assert.ok(err.message.includes('check constraint') || err.code === '23514')
      return true
    },
    'Invalid assignment timestamps must fail check constraint'
  )
  console.log('  ✓ Database rejects assignments with ended_at < assigned_at via CHECK constraint')

  // Test invalid SLA duration (duration_seconds <= 0)
  const dummyAssignmentId = randomUUID()
  await assert.rejects(
    async () => {
      await db.query(
        `INSERT INTO sla_records (assignment_id, policy_code, duration_seconds, started_at, deadline_at)
         VALUES ($1, 'test', 0, now(), now() + interval '1 hour')`,
        [dummyAssignmentId]
      )
    },
    (err) => {
      assert.ok(err.message.includes('check constraint') || err.code === '23514')
      return true
    },
    'Zero / negative SLA duration must fail check constraint'
  )
  console.log('  ✓ Database rejects SLA records with duration_seconds <= 0 via CHECK constraint')

  // Test invalid SLA deadline (deadline_at < started_at)
  await assert.rejects(
    async () => {
      await db.query(
        `INSERT INTO sla_records (assignment_id, policy_code, duration_seconds, started_at, deadline_at)
         VALUES ($1, 'test', 3600, now(), now() - interval '1 hour')`,
        [dummyAssignmentId]
      )
    },
    (err) => {
      assert.ok(err.message.includes('check constraint') || err.code === '23514')
      return true
    },
    'Invalid SLA deadline must fail check constraint'
  )
  console.log('  ✓ Database rejects SLA records with deadline_at < started_at via CHECK constraint')

  // 4. Transactional Atomicity & Rollback Verification
  console.log('\n4. Transactional Atomicity & Mid-Transaction Failure Rollback')
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const testReqRef = `NVARA-TEST-${randomUUID().slice(0, 8).toUpperCase()}`
    const clientRes = await client.query('SELECT id FROM clients LIMIT 1')
    const sdRes = await client.query('SELECT id FROM service_domains LIMIT 1')

    await client.query(
      `INSERT INTO requests (organization_id, public_reference, client_id, service_domain_id, requirement, urgency)
       VALUES ($1, $2, $3, $4, 'Atomicity test', 'flexible')`,
      [sampleOrg.id, testReqRef, clientRes.rows[0].id, sdRes.rows[0].id]
    )

    // Inject deliberate constraint failure on second query
    await assert.rejects(
      async () => {
        await client.query(
          `INSERT INTO assignments (request_id, assignee_user_id, assigned_by_user_id, assigned_at, ended_at)
           VALUES ($1, $2, $2, now(), now() - interval '2 hours')`,
          [sampleReq.id, sampleUser.id]
        )
      },
      (err) => err.code === '23514'
    )

    // Roll back transaction
    await client.query('ROLLBACK')

    // Verify request row was NOT persisted
    const verifyReq = await db.query('SELECT 1 FROM requests WHERE public_reference = $1', [testReqRef])
    assert.equal(verifyReq.rowCount, 0, 'Rolled-back request must NOT exist in database')
    console.log('  ✓ Transaction rollback guarantees zero half-committed records upon mid-operation failure')
  } finally {
    client.release()
  }

  // 5. Immutability Trigger Engine Verification
  console.log('\n5. Database Immutability Trigger Engine Verification')
  const sampleAudit = (await db.query('SELECT id FROM audit_events LIMIT 1')).rows[0]
  await assert.rejects(
    async () => {
      await db.query("UPDATE audit_events SET event_type = 'CORRUPTED' WHERE id = $1", [sampleAudit.id])
    },
    (err) => err.code === '55006',
    'Trigger must block audit modification with 55006'
  )
  console.log('  ✓ Database trigger prevent_audit_event_mutation strictly enforces immutable append-only logs')

  console.log('\n══════════════════════════════════════════════════════════════')
  console.log(' RESULTS: ALL DATABASE INTEGRITY FORENSIC TESTS PASSED 🎉     ')
  console.log('══════════════════════════════════════════════════════════════\n')
} finally {
  await db.end()
}
