/**
 * Scratch harness for dsh-stigmergy: exercises the plugin through a fake
 * Cordis context (no DSH runtime needed). Not part of the package.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { apply, normalizeConfig } from '../index.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stigmergy-'))
const sessions = new Map()

function session(id, cwd, parentSession) {
  const s = { id, header: { id, cwd, ...(parentSession === undefined ? {} : { parentSession }) } }
  sessions.set(id, s)
  return s
}

const rootSession = session('session-root0001', root)
const childSession = session('session-child002', root, 'session-root0001')
const grandSession = session('session-grand003', root, 'session-child002')
const otherSession = session('session-other004', root)

const rootAgent = { id: rootSession.id, session: rootSession }
const childAgent = { id: childSession.id, session: childSession }
const grandAgent = { id: grandSession.id, session: grandSession }
const otherAgent = { id: otherSession.id, session: otherSession }

const tools = new Map()
const sections = []
const contexts = []
const ctx = {
  tools: {
    register: (definition) => { tools.set(definition.name, definition); return () => {} },
    get: (name) => tools.get(name),
  },
  systemPrompt: {
    section: (section) => { sections.push(section); return () => {} },
    context: (context) => { contexts.push(context); return () => {} },
  },
  get: (name) => (name === 'sessions' ? { get: (id) => sessions.get(id) } : undefined),
  logger: { warn: (message) => console.warn('[warn]', message) },
}

apply(ctx, {})

const leave = tools.get('stigmergy_leave')
const read = tools.get('stigmergy_read')
const clear = tools.get('stigmergy_clear')
assert.ok(leave && read && clear, 'three tools registered')

// --- a trace from a child is visible to the parent and to a grandchild -----
const left = await leave.execute(
  { key: 'auth/schema', text: 'Use snake_case columns; migration in db/0042.sql', kind: 'decision' },
  { agent: childAgent },
)
assert.match(left, /auth\/schema/)
assert.match(left, /field now holds 1 trace/)
assert.deepEqual(leave.output.schema, { type: 'string' })

const parentView = contexts[0].text({ agent: rootAgent, scope: rootAgent })
assert.match(parentView, /auth\/schema/)
assert.match(parentView, /snake_case/)
assert.match(parentView, /you are ot0001/)

const grandView = contexts[0].text({ agent: grandAgent, scope: grandAgent })
assert.match(grandView, /auth\/schema/, 'a grandchild shares the tree field')

const otherView = contexts[0].text({ agent: otherAgent, scope: otherAgent })
assert.equal(otherView, '', 'an unrelated tree sees nothing')

// --- replacement keeps one slot, bumps rev --------------------------------
await leave.execute({ key: 'auth/schema', text: 'Revised: camelCase, see db/0043.sql' }, { agent: rootAgent })
const field = await read.execute({}, { agent: childAgent })
assert.match(field, /1 of 1 traces/)
assert.match(field, /rev 2/)
assert.doesNotMatch(field, /snake_case/, 'the slot was replaced')

// --- truncation in the summary, full text in read -------------------------
const long = 'x'.repeat(600)
await leave.execute({ key: 'long', text: long }, { agent: childAgent })
const clipped = contexts[0].text({ agent: rootAgent, scope: rootAgent })
assert.match(clipped, /…/, 'summary truncates')
assert.ok(clipped.length < 1600, 'summary stays bounded')
const full = await read.execute({ keys: ['long'] }, { agent: rootAgent })
assert.ok(full.includes('x'.repeat(600)), 'read returns the untruncated text')

// --- evaporation ----------------------------------------------------------
await leave.execute({ key: 'ephemeral', text: 'gone soon', ttl_minutes: 0 }, { agent: childAgent })
const before = await read.execute({}, { agent: rootAgent })
assert.match(before, /ephemeral/)
await clear.execute({ key: 'ephemeral' }, { agent: rootAgent })
const after = await read.execute({}, { agent: rootAgent })
assert.doesNotMatch(after, /ephemeral/)

// --- an unknown kind fails instead of being silently rewritten ------------
assert.throws(
  () => leave.execute({ key: 'bad', text: 'x', kind: 'claim' }, { agent: childAgent }),
  /`kind` must be one of/,
)
assert.doesNotMatch(await read.execute({}, { agent: rootAgent }), /bad/, 'a rejected write leaves no trace')

// --- a numeric string TTL is accepted and normalized ----------------------
await leave.execute({ key: 'ttl', text: 'short lived', ttl_minutes: '1' }, { agent: childAgent })
assert.match(await read.execute({ keys: ['ttl'] }, { agent: rootAgent }), /expires in 1m/)
assert.throws(
  () => leave.execute({ key: 'ttl', text: 'x', ttl_minutes: 'soon' }, { agent: childAgent }),
  /`ttl_minutes` must be a number/,
)

// --- persistence: a fresh instance replays the mirror ---------------------
const files = fs.readdirSync(path.join(root, '.dsh-stigmergy'))
assert.equal(files.length, 1, 'one mirror per colony')
const mirror = fs.readFileSync(path.join(root, '.dsh-stigmergy', files[0]), 'utf8')
assert.match(mirror, /auth\/schema/)

const tools2 = new Map()
const contexts2 = []
const ctx2 = {
  tools: { register: (definition) => { tools2.set(definition.name, definition); return () => {} }, get: (name) => tools2.get(name) },
  systemPrompt: { section: () => () => {}, context: (context) => { contexts2.push(context); return () => {} } },
  get: (name) => (name === 'sessions' ? { get: (id) => sessions.get(id) } : undefined),
  logger: { warn: console.warn },
}
apply(ctx2, {})
const replayed = contexts2[0].text({ agent: rootAgent, scope: rootAgent })
assert.match(replayed, /Revised: camelCase/, 'state survives a restart')

// --- external edit is adopted --------------------------------------------
const mirrorPath = path.join(root, '.dsh-stigmergy', files[0])
fs.appendFileSync(mirrorPath, `${JSON.stringify({ v: 1, op: 'put', trace: {
  key: 'from-shell', text: 'written by an ordinary tool', kind: 'note', author: 'shell',
  from: 'session-shell', createdAt: Date.now(), updatedAt: Date.now(), rev: 1, expiresAt: null,
} })}\n`)
const adopted = contexts2[0].text({ agent: rootAgent, scope: rootAgent })
assert.match(adopted, /from-shell/, 'an external append is picked up')

// --- config normalization -------------------------------------------------
const options = normalizeConfig({ maxEntries: '2', scope: 'nonsense', defaultTtlMinutes: -5 })
assert.equal(options.maxEntries, 2)
assert.equal(options.scope, 'tree')
assert.equal(options.defaultTtlMinutes, 0)
assert.equal(normalizeConfig(undefined).directory, '.dsh-stigmergy')

// --- prompt section and field context are registered ----------------------
assert.equal(sections.length, 1)
assert.match(sections[0].text({ scope: rootAgent }), /stigmergic/)
assert.equal(contexts.length, 1)

fs.rmSync(root, { recursive: true, force: true })
console.log('all checks passed')
