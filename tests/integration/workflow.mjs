import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

const base = process.env.API_ORIGIN ?? process.env.API_URL ?? 'http://127.0.0.1:4001'
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://nvara:nvara_local_dev_only@localhost:55432/nvara' })

// Login as PM
const pmLoginRes = await fetch(`${base}/v1/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'pm@nvaramedia.com', password: 'Nvara#PM2026!Secure' }),
})
assert.equal(pmLoginRes.status, 200)
const pmCookie = pmLoginRes.headers.get('set-cookie')?.split(';')[0] || ''

// Login as Rohan (Specialist)
const rohanLoginRes = await fetch(`${base}/v1/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'rohan.mehta@nvaramedia.com', password: 'Rohan#Ops2026!Dev' }),
})
assert.equal(rohanLoginRes.status, 200)
const rohanCookie = rohanLoginRes.headers.get('set-cookie')?.split(';')[0] || ''

// Login as Priya (Specialist)
const priyaLoginRes = await fetch(`${base}/v1/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'priya.sharma@nvaramedia.com', password: 'Priya#Ops2026!Dev' }),
})
assert.equal(priyaLoginRes.status, 200)
const priyaCookie = priyaLoginRes.headers.get('set-cookie')?.split(';')[0] || ''

async function call(path, cookie, body, key) {
  const r = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, 'Idempotency-Key': key },
    body: JSON.stringify(body),
  })
  return { status: r.status, body: await r.json() }
}

async function get(path, cookie) {
  const r = await fetch(base + path, { headers: { Cookie: cookie } })
  return { status: r.status, body: await r.json() }
}

const submission = {
  name: 'Workflow Integration',
  company: 'Workflow Test',
  email: `workflow-${randomUUID()}@example.test`,
  phone: '+919999999999',
  serviceDomain: 'seo',
  requirement: 'Exercise the complete durable workflow mutation path.',
  urgency: 'soon',
}

const created = await fetch(base + '/v1/client/requests', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `workflow-${randomUUID()}` },
  body: JSON.stringify(submission),
})
assert.equal(created.status, 201)
const { reference } = await created.json()

let detail = (await get(`/v1/pm/requests/${reference}`, pmCookie)).body.request
assert.equal(detail.version, 1)

const members = (await get('/v1/pm/team-members', pmCookie)).body.teamMembers
const rohan = members.find((m) => m.email === 'rohan.mehta@nvaramedia.com') || members[0]

const assigned = await call(`/v1/pm/requests/${reference}/assignments`, pmCookie, { assigneeUserId: rohan.id, expectedVersion: detail.version }, `assign-${randomUUID()}`)
assert.equal(assigned.status, 200)
assert.equal(assigned.body.request.version, 2)

detail = (await get(`/v1/pm/requests/${reference}`, pmCookie)).body.request
assert.equal(detail.version, 2)

// Non-assignee Priya attempts acknowledgement -> 403 Forbidden
const forbidden = await call(`/v1/requests/${reference}/acknowledge`, priyaCookie, { expectedVersion: 2 }, `wrong-${randomUUID()}`)
assert.equal(forbidden.status, 403)

// Assigned specialist Rohan acknowledges -> 200
const acknowledged = await call(`/v1/requests/${reference}/acknowledge`, rohanCookie, { expectedVersion: 2 }, `ack-${randomUUID()}`)
assert.equal(acknowledged.status, 200)
assert.equal(acknowledged.body.request.version, 3)

// Rohan starts work -> 200
const started = await call(`/v1/requests/${reference}/start-work`, rohanCookie, { expectedVersion: 3 }, `start-${randomUUID()}`)
assert.equal(started.status, 200)
assert.equal(started.body.request.status, 'in_progress')

// Rohan resolves -> 200
const resolved = await call(`/v1/requests/${reference}/resolve`, rohanCookie, { expectedVersion: 4 }, `resolve-${randomUUID()}`)
assert.equal(resolved.status, 200)
assert.equal(resolved.body.request.status, 'resolved')
assert.equal(resolved.body.request.sla.status, 'closed')

const refreshed = (await get(`/v1/pm/requests/${reference}`, pmCookie)).body.request
assert.equal(refreshed.status, 'resolved')
assert.equal(refreshed.version, 5)

await db.end()
console.log('Workflow mutation integration passed')

