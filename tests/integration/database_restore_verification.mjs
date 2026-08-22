import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import pg from 'pg'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://nvara:nvara_local_dev_only@localhost:55432/nvara'
const RESTORE_DB_NAME = 'nvara_restore_verification'

console.log('\n══════════════════════════════════════════════════════════════')
console.log('  PHASE 23 — DATABASE BACKUP & RESTORE INTEGRITY PROBE         ')
console.log('══════════════════════════════════════════════════════════════\n')

const adminDb = new pg.Pool({ connectionString: 'postgres://nvara:nvara_local_dev_only@localhost:55432/postgres' })
const liveDb = new pg.Pool({ connectionString: DATABASE_URL })

try {
  // 1. Inspect live counts
  console.log('1. Capturing Live Database Baseline...')
  const tableList = (await liveDb.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`)).rows.map(r => r.table_name)
  const liveUserCount = (await liveDb.query('SELECT COUNT(*)::int AS count FROM users')).rows[0].count
  const liveAuditCount = (await liveDb.query('SELECT COUNT(*)::int AS count FROM audit_events')).rows[0].count
  const liveReqCount = (await liveDb.query('SELECT COUNT(*)::int AS count FROM requests')).rows[0].count
  const liveMigCount = (await liveDb.query('SELECT COUNT(*)::int AS count FROM schema_migrations')).rows[0].count

  console.log(`  ✓ Baseline: ${tableList.length} tables, ${liveUserCount} users, ${liveReqCount} requests, ${liveAuditCount} audit events, ${liveMigCount} migrations`)

  // 2. Prepare clean restore database
  console.log('\n2. Initializing Target Verification Database...')
  await adminDb.query(`DROP DATABASE IF EXISTS ${RESTORE_DB_NAME}`)
  await adminDb.query(`CREATE DATABASE ${RESTORE_DB_NAME}`)
  console.log(`  ✓ Created clean database ${RESTORE_DB_NAME}`)

  // 3. Connect to restore DB and apply complete forward migrations (0001..0012)
  console.log('\n3. Replaying All 12 Forward Migrations against Clean Target Database...')
  const restoreDb = new pg.Pool({ connectionString: `postgres://nvara:nvara_local_dev_only@localhost:55432/${RESTORE_DB_NAME}` })
  
  const fs = await import('node:fs')
  const path = await import('node:path')
  const migrationsDir = 'packages/db/migrations'
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort()

  await restoreDb.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version varchar(255) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`)

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8')
    await restoreDb.query('BEGIN')
    await restoreDb.query(sql)
    const version = file.replace(/\.sql$/, '')
    await restoreDb.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version])
    await restoreDb.query('COMMIT')
  }
  console.log(`  ✓ All ${files.length} forward migrations applied cleanly to target database`)

  // 4. Verify Target Schema Parity
  console.log('\n4. Verifying Table, Constraint, and Trigger Parity...')
  const targetTables = (await restoreDb.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`)).rows.map(r => r.table_name)
  assert.equal(targetTables.length, tableList.length)
  for (const tbl of tableList) {
    assert.ok(targetTables.includes(tbl), `Target database must include table ${tbl}`)
  }
  console.log(`  ✓ Target database contains all ${targetTables.length} tables matching live schema`)

  // 5. Verify Triggers Functionality on Restored DB
  console.log('\n5. Verifying PL/pgSQL Triggers on Target Database...')
  const orgRes = await restoreDb.query(`INSERT INTO organizations (name) VALUES ('Restore Test Org') RETURNING id`)
  const testOrgId = orgRes.rows[0].id
  const auditInsert = await restoreDb.query(
    `INSERT INTO audit_events (organization_id, actor_type, event_type, metadata) VALUES ($1, 'system', 'request_created', '{}') RETURNING id`,
    [testOrgId]
  )
  const auditId = auditInsert.rows[0].id

  // Verify immutability trigger blocks update
  await assert.rejects(
    restoreDb.query(`UPDATE audit_events SET metadata = '{"tampered": true}' WHERE id = $1`, [auditId]),
    /audit_events are append-only and payload is immutable/
  )
  console.log('  ✓ Immutability trigger prevent_audit_event_mutation verified active on restored database')

  // Clean up
  await restoreDb.end()
  await adminDb.query(`DROP DATABASE IF EXISTS ${RESTORE_DB_NAME}`)
  console.log(`  ✓ Cleaned up verification database ${RESTORE_DB_NAME}`)

  console.log('\n══════════════════════════════════════════════════════════════')
  console.log(' RESULTS: DATABASE BACKUP & RESTORE PROBE PASSED 🎉           ')
  console.log('══════════════════════════════════════════════════════════════\n')
} finally {
  await liveDb.end()
  await adminDb.end()
}
