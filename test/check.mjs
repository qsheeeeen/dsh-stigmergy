/**
 * Regression harness for dsh-stigmergy: exercises the plugin through a fake
 * Cordis context (no DSH runtime needed). Not part of the published files.
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

function fakeContext(tools, contexts, sections = [], services = {}) {
  return {
    tools: {
      register: (definition) => { tools.set(definition.name, definition); return () => {} },
      get: (name) => tools.get(name),
    },
    systemPrompt: {
      section: (section) => { sections.push(section); return () => {} },
      context: (context) => { contexts.push(context); return () => {} },
    },
    get: (name) => (name === 'sessions' ? { get: (id) => sessions.get(id) } : services[name]),
    logger: { warn: (message) => console.warn('[warn]', message) },
  }
}

const tools = new Map()
const contexts = []
const sections = []
apply(fakeContext(tools, contexts, sections), {})

const leave = tools.get('stigmergy_leave')
const read = tools.get('stigmergy_read')
const clear = tools.get('stigmergy_clear')
assert.ok(leave && read && clear, 'three tools registered')
assert.deepEqual(leave.output.schema, { type: 'string' })

// --- the split: peers pay for the title, the detail costs nothing ----------
const left = await leave.execute({
  key: 'auth/schema',
  title: 'Columns are snake_case; migration lives in db/0042.sql',
  detail: 'Renamed 14 columns in db/0042.sql. Evidence: 3 failing tests in test/auth.spec.ts; run `pnpm test auth` to confirm.',
  kind: 'decision',
}, { agent: childAgent })
assert.match(left, /auth\/schema/)
assert.match(left, /field now holds 1 trace/)

const parentView = contexts[0].text({ agent: rootAgent, scope: rootAgent })
assert.match(parentView, /snake_case/, 'the title reaches the parent')
assert.doesNotMatch(parentView, /db\/0042\.sql\. Evidence/, 'the detail does not')
assert.match(parentView, /you are ot0001/)

const grandView = contexts[0].text({ agent: grandAgent, scope: grandAgent })
assert.match(grandView, /snake_case/, 'a grandchild shares the tree field')

assert.equal(contexts[0].text({ agent: otherAgent, scope: otherAgent }), '', 'an unrelated tree sees nothing')

// --- read is what fetches the detail --------------------------------------
const whole = await read.execute({}, { agent: childAgent })
assert.match(whole, /Columns are snake_case/)
assert.match(whole, /Renamed 14 columns/, 'read returns the detail')
assert.match(whole, /1 of 1 traces/)
assert.match(whole, /rev 1/)

// --- replacement keeps one slot, bumps rev --------------------------------
await leave.execute({ key: 'auth/schema', title: 'Revised: camelCase, see db/0043.sql' }, { agent: rootAgent })
const replaced = await read.execute({}, { agent: childAgent })
assert.match(replaced, /rev 2/)
assert.doesNotMatch(replaced, /snake_case/, 'the slot was replaced')
assert.doesNotMatch(replaced, /db\/0042\.sql\. Evidence/, 'the old detail is gone with the old trace')

// --- bounds are enforced instead of silently rewritten --------------------
await assert.rejects(
  () => leave.execute({ key: 'bad', title: 'x'.repeat(161) }, { agent: childAgent }),
  /`title` must be at most 160 characters/,
)
await assert.rejects(
  () => leave.execute({ key: 'bad', title: 'ok', detail: 'y'.repeat(4001) }, { agent: childAgent }),
  /`detail` must be at most 4000 characters/,
)
await assert.rejects(
  () => leave.execute({ key: 'bad', title: '   ' }, { agent: childAgent }),
  /`title` must be a non-empty string/,
)
await assert.rejects(
  () => leave.execute({ key: 'bad', title: 'x', kind: 'claim' }, { agent: childAgent }),
  /`kind` must be one of/,
)
assert.doesNotMatch(await read.execute({}, { agent: rootAgent }), /bad/, 'a rejected write leaves no trace')

// --- a numeric string TTL is accepted and normalized ----------------------
await leave.execute({ key: 'ttl', title: 'Short lived', ttl_minutes: '1' }, { agent: childAgent })
assert.match(await read.execute({ keys: ['ttl'] }, { agent: rootAgent }), /expires in 1m/)
await assert.rejects(
  () => leave.execute({ key: 'ttl', title: 'x', ttl_minutes: 'soon' }, { agent: childAgent }),
  /`ttl_minutes` must be a number/,
)

// --- retraction -----------------------------------------------------------
await leave.execute({ key: 'ephemeral', title: 'Gone soon', ttl_minutes: 0 }, { agent: childAgent })
assert.match(await read.execute({}, { agent: rootAgent }), /ephemeral/)
await clear.execute({ key: 'ephemeral' }, { agent: rootAgent })
assert.doesNotMatch(await read.execute({}, { agent: rootAgent }), /ephemeral/)

// --- persistence: the mirror carries both halves --------------------------
const files = fs.readdirSync(path.join(root, '.dsh-stigmergy'))
assert.equal(files.length, 1, 'one mirror per colony')
const mirrorPath = path.join(root, '.dsh-stigmergy', files[0])
const mirror = fs.readFileSync(mirrorPath, 'utf8')
assert.match(mirror, /"title":"Revised: camelCase/)
assert.match(mirror, /"detail":/)
assert.doesNotMatch(mirror, /"text":/, 'new records no longer store a single text')

const tools2 = new Map()
const contexts2 = []
apply(fakeContext(tools2, contexts2), {})
assert.match(
  contexts2[0].text({ agent: rootAgent, scope: rootAgent }),
  /Revised: camelCase/,
  'state survives a restart',
)

// --- the mirror shape is exact: a partial record is dropped, not repaired --
fs.appendFileSync(mirrorPath, `${JSON.stringify({ v: 1, op: 'put', trace: {
  key: 'partial', title: 'Half a trace', author: 'shell', from: 'session-shell',
  createdAt: Date.now(), updatedAt: Date.now(), rev: 1, expiresAt: null,
} })}\n`)
assert.doesNotMatch(
  contexts2[0].text({ agent: rootAgent, scope: rootAgent }),
  /partial/,
  'a record without detail and role is not a trace',
)

// --- an external writer with the full shape is adopted ---------------------
fs.appendFileSync(mirrorPath, `${JSON.stringify({ v: 1, op: 'put', trace: {
  key: 'from-shell', title: 'Written by an ordinary tool', detail: 'appended straight to the mirror',
  kind: 'note', author: 'shell', role: 'subagent', from: 'session-shell',
  createdAt: Date.now(), updatedAt: Date.now(), rev: 1, expiresAt: null,
} })}\n`)
const adopted = contexts2[0].text({ agent: rootAgent, scope: rootAgent })
assert.match(adopted, /from-shell/, 'a complete external record is adopted')
assert.match(
  await tools2.get('stigmergy_read').execute({ keys: ['from-shell'] }, { agent: rootAgent }),
  /from shell \(subagent\)/,
  'its detail and attribution survive',
)

// --- config normalization -------------------------------------------------
const options = normalizeConfig({ maxEntries: '2', scope: 'nonsense', defaultTtlMinutes: -5 })
assert.equal(options.maxEntries, 2)
assert.equal(options.scope, 'tree')
assert.equal(options.defaultTtlMinutes, 0)
assert.equal(normalizeConfig(undefined).directory, '.dsh-stigmergy')

// --- the protocol section is registered and gated on tool visibility ------
assert.equal(sections.length, 1)
assert.match(sections[0].text({ scope: rootAgent }), /stigmergic/)
assert.equal(contexts.length, 1)

// --- identity resolves per coordination mode ------------------------------
const teamSession = session('session-team005', root, 'session-root0001')
const teamAgent = { id: teamSession.id, session: teamSession }
const roster = new Map([[teamAgent.id, { root: rootAgent, id: 'team-1', role: 'teammate', name: 'parser' }]])
const catalog = new Map([[childSession.id, 'parse csv pipeline']])

const identityTools = new Map()
const identityContexts = []
apply(fakeContext(identityTools, identityContexts, [], {
  agentTeams: { tryMembership: (agent) => roster.get(agent.id) },
  subagents: {
    listChildren: async (parentId) => (parentId === rootSession.id
      ? [...catalog].map(([id, label]) => ({ id, createdAt: 1, mode: 'continuable', label }))
      : []),
  },
}), {})

const identityLeave = identityTools.get('stigmergy_leave')
const identityRead = identityTools.get('stigmergy_read')

const teamLeft = await identityLeave.execute({ key: 'id/team', title: 'Written by a teammate' }, { agent: teamAgent })
assert.match(teamLeft, /as parser \(teammate\)/, 'a team member is named by its roster name')
assert.match(
  await identityRead.execute({ keys: ['id/team'] }, { agent: rootAgent }),
  /from parser \(teammate/,
  'the read shows the name and role, not just an id',
)

assert.match(
  await identityLeave.execute({ key: 'id/delegate', title: 'Written by a delegated child' }, { agent: childAgent }),
  /as parse csv pipeline \(subagent\)/,
  'a delegated child is named by the label its parent chose',
)

assert.match(
  await identityLeave.execute({ key: 'id/override', title: 'Explicit name', author: 'migration-owner' }, { agent: childAgent }),
  /as migration-owner/,
  'an explicit author wins',
)

const identityView = identityContexts[0].text({ agent: rootAgent, scope: rootAgent })
assert.match(identityView, /id\/team · parser/, 'the snapshot renders the resolved name')
assert.match(identityView, /id\/delegate · parse csv pipeline/)

fs.rmSync(root, { recursive: true, force: true })
console.log('all checks passed')
