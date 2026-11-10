/**
 * Stigmergy — coordination through a shared environment instead of messages.
 *
 * An ant does not tell another ant where the food is. It changes the
 * environment: it lays a pheromone trail, and any ant that later walks there
 * follows it. The trace carries the information, so there is no sender, no
 * recipient, and no rendezvous. Biologists call this stigmergy.
 *
 * This plugin gives one session's agents the same mechanism. Every agent in the
 * session — the parent and all of its subagents — reads one bounded, evaporating
 * field of traces. The field is rendered into each agent's runtime context
 * before every model request, so a trace one agent leaves is already in
 * another agent's next step: no `send_message`, no parent relaying, and no N²
 * message graph.
 *
 * The surfaces are three tools:
 *   - `stigmergy_leave` writes or replaces one trace; `key` names the trace,
 *     so the field stays current state rather than a chat log.
 *   - `stigmergy_read` returns the field, or the detail behind named traces.
 *   - `stigmergy_clear` removes a trace before it evaporates.
 *
 * The field is mirrored to `<cwd>/.dsh-stigmergy/<scope>.jsonl`, so it
 * survives a Host restart and ordinary file tools can inspect it.
 *
 * @module @local/dsh-stigmergy
 */

import fs from 'node:fs'
import path from 'node:path'

/**
 * Services required before activation. `sessions` is read with `ctx.get()`
 * because the field still works — it just cannot walk an ancestor chain — in a
 * deployment without a session store.
 */
export const inject = ['tools', 'systemPrompt']

/** Tool names; also the identity used to decide whether the field is visible. */
const LEAVE = 'stigmergy_leave'
const READ = 'stigmergy_read'
const CLEAR = 'stigmergy_clear'

/** The trace kinds a caller may claim. Free text would drift; a closed set keeps the field readable. */
const KINDS = ['note', 'decision', 'finding', 'task', 'question', 'done']

/**
 * Bounds for the two halves of a trace. Every agent pays for the title on every
 * step, so it is short by contract; the detail is paid only on request.
 */
const TITLE_LIMIT = 160
const DETAIL_LIMIT = 4000

/** Where the field sits among runtime contexts: after delegation facts, before harness source. */
const FIELD_CONTEXT_ORDER = 150

/** Where the protocol sits among prompt sections: after the delegation tool, before reporting tools. */
const PROTOCOL_SECTION_ORDER = 2950

/**
 * The standing explanation of the mechanism. It is static text in the system
 * prompt, so it costs the same tokens on every step and never grows with the
 * field. The field itself is a separate runtime context.
 */
const PROTOCOL = [
  'Coordination here is stigmergic: the agents in this session share one field of traces',
  '(`stigmergy_leave`, `stigmergy_read`, `stigmergy_clear`) that is read before each of your steps.',
  'Publish what another agent needs — a decision, a finding, a claim, a handoff, a blocker — by',
  'changing the field instead of sending a message; they pick it up on their own next step. Read the',
  'field before you redo work someone else may have already started.',
].join(' ')

/** Defaults for every tunable; `cordis.patch.yml` overrides them per profile. */
const DEFAULTS = Object.freeze({
  directory: '.dsh-stigmergy',
  scope: 'session',
  maxEntries: 12,
  maxTextChars: 280,
  defaultTtlMinutes: 90,
  promptSection: true,
})

/**
 * Short, stable, human-sized label for an agent.
 * @param id - the agent/session id.
 * @returns the last six characters, without the `session-` prefix.
 */
function shortId(id) {
  const text = String(id ?? '')
  const cut = text.startsWith('session-') ? text.slice('session-'.length) : text
  return cut.slice(-6) || 'unknown'
}

/**
 * Render an age as a compact, human-readable span.
 * @param time - epoch milliseconds.
 * @returns the age, such as `8s`, `3m`, or `2h`.
 */
function ago(time) {
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`
  return `${Math.round(seconds / 86400)}d`
}

/**
 * Cut text to a bound without splitting a surrogate pair.
 * @param text - source text.
 * @param max - maximum characters to keep.
 * @returns the text, with an ellipsis when it was cut.
 */
function clip(text, max) {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/**
 * Collapse whitespace so one trace stays one readable line in the summary.
 * @param text - source text.
 * @returns single-line text.
 */
function oneLine(text) {
  return String(text).replace(/\s+/g, ' ').trim()
}

/**
 * Coerce one integer option, falling back when the value is unusable.
 * @param value - the raw configured value.
 * @param fallback - the default.
 * @param min - inclusive lower bound.
 * @param max - inclusive upper bound.
 * @returns the clamped integer.
 */
function integer(value, fallback, min, max) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

/**
 * Normalize the row's config, so a hand-edited patch cannot disable the plugin
 * with a typo.
 * @param raw - the row's `config` value, possibly absent or partly invalid.
 * @returns complete options.
 */
function normalizeConfig(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {}
  const directory = typeof config.directory === 'string' ? config.directory.trim() : DEFAULTS.directory
  return {
    directory,
    scope: config.scope === 'workspace' ? 'workspace' : 'session',
    maxEntries: integer(config.maxEntries, DEFAULTS.maxEntries, 1, 50),
    maxTextChars: integer(config.maxTextChars, DEFAULTS.maxTextChars, 60, 2000),
    defaultTtlMinutes: integer(config.defaultTtlMinutes, DEFAULTS.defaultTtlMinutes, 0, 10080),
    promptSection: config.promptSection !== false,
  }
}

/**
 * Parse one trace read back from the mirror. The shape is exact: a record that
 * does not carry every required field is not a trace, and is dropped rather
 * than repaired, because repairing would put a half-written line into a field
 * that every agent reads on every step.
 * @param value - a parsed JSONL record payload.
 * @returns the trace, or undefined when the record is not one.
 */
function readTrace(value) {
  if (value === null || typeof value !== 'object') return undefined
  for (const field of ['key', 'title', 'detail', 'author', 'role', 'from']) {
    if (typeof value[field] !== 'string') return undefined
  }
  if (typeof value.updatedAt !== 'number') return undefined
  return {
    key: value.key,
    title: value.title,
    detail: value.detail,
    kind: value.kind,
    author: value.author,
    role: value.role,
    from: value.from,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    rev: value.rev,
    expiresAt: value.expiresAt,
  }
}

/**
 * One field: the traces in one scope, backed by an append-only JSONL mirror
 * under the scope's working directory.
 */
class Field {
  /** @type {ReturnType<typeof normalizeConfig>} */
  #options
  /** @type {import('@deepseek-ai/cordis').Context} */
  #ctx
  /** scope key → field state. @type {Map<string, {key: string, file: string | undefined, entries: Map<string, object>, loaded: boolean, mtimeMs: number, appends: number}>} */
  #states = new Map()
  /** agent id → scope key. @type {Map<string, string>} */
  #scopeKeys = new Map()
  /** agent id → resolved identity. @type {Map<string, {id: string, name: string, role: string}>} */
  #identities = new Map()
  /** agent id → identity resolutions attempted, bounded so a failing lookup cannot spin. @type {Map<string, number>} */
  #attempts = new Map()

  /**
   * @param ctx - the plugin context, for optional services and diagnostics.
   * @param options - normalized plugin options.
   */
  constructor(ctx, options) {
    this.#ctx = ctx
    this.#options = options
  }

  /**
   * Start resolving an agent's identity without blocking the caller. The name is
   * needed by the synchronous render path, and it can fail at creation time —
   * the parent's catalog entry is written around the same moment the child
   * appears — so a small number of later attempts are allowed.
   * @param agent - the agent whose name is wanted.
   */
  warm(agent) {
    const id = agent?.id
    if (typeof id !== 'string' || this.#identities.has(id)) return
    const attempts = this.#attempts.get(id) ?? 0
    if (attempts >= 3) return
    this.#attempts.set(id, attempts + 1)
    this.identify(agent).catch(() => {})
  }

  /**
   * Resolve who is writing, so a trace carries a name another agent can act on
   * rather than an opaque session id.
   *
   * The two coordination modes the harness supports have different durable
   * identities. A Team member has a name the roster and the other agents already
   * use; a plain delegated child only has the label its parent chose when
   * starting it. Both are recognisable to another agent reading the field; a
   * session id is not.
   * Resolution is cached because a label costs one parent-catalog read and
   * never changes afterwards.
   *
   * @param agent - the agent about to write.
   * @returns its identity: stable `id`, display `name`, and `role`.
   */
  async identify(agent) {
    const id = agent?.id
    if (typeof id !== 'string') throw new Error('cannot resolve an identity without an agent id')
    const cached = this.#identities.get(id)
    if (cached !== undefined) return cached

    const header = agent.session?.header

    // A Team name outranks a subagent label: it is what other agents address.
    const teams = this.#ctx.get('agentTeams')
    if (teams !== undefined) {
      try {
        const membership = teams.tryMembership(agent)
        if (membership !== undefined) {
          const identity = { id, name: String(membership.name), role: membership.role }
          this.#identities.set(id, identity)
          return identity
        }
      } catch {}
    }

    // A delegated child is known by the label its parent chose.
    const parentId = header?.parentSession
    if (parentId !== undefined && parentId !== null) {
      const subagents = this.#ctx.get('subagents')
      if (subagents !== undefined) {
        try {
          const rows = await subagents.listChildren(parentId)
          const label = rows?.find?.((entry) => entry.id === id)?.label
          if (typeof label === 'string' && label.trim().length > 0) {
            const identity = { id, name: label.trim().slice(0, 60), role: 'subagent' }
            this.#identities.set(id, identity)
            return identity
          }
        } catch {}
      }
    }

    const identity = {
      id,
      name: shortId(id),
      role: parentId === undefined || parentId === null ? 'root' : 'subagent',
    }
    this.#identities.set(id, identity)
    return identity
  }

  /**
   * The display name already resolved for an agent, for the synchronous render
   * path. A caller that has not written yet falls back to its short id.
   * @param agent - the viewing agent.
   * @returns its name, or the session id suffix.
   */
  nameOf(agent) {
    return this.#identities.get(agent?.id)?.name ?? shortId(agent?.id)
  }

  /**
   * Resolve the scope an agent's field belongs to. In `session` scope it is the
   * root session of the subagent tree the agent was spawned in, so a parent and
   * all of its descendants — however deep — share one field. In `workspace`
   * scope the working directory is the scope instead, so separate conversations
   * in one project share a field.
   *
   * Resolution walks live ancestor sessions, because a child's header names its
   * parent and the parent is alive while its child is. When an ancestor is
   * already gone the chain stops at the nearest live session, which keeps the
   * key stable for the agents that are still running.
   *
   * @param agent - the calling agent.
   * @returns the scope key, or undefined when the agent has no session.
   */
  scopeKeyOf(agent) {
    const id = agent?.id
    const own = agent?.session
    if (typeof id !== 'string' || own === undefined || own === null) return undefined

    const cached = this.#scopeKeys.get(id)
    if (cached !== undefined) return cached

    const sessions = this.#ctx.get('sessions')
    let root = own
    if (this.#options.scope === 'session') {
      const seen = new Set([own.id])
      let cursor = own
      for (;;) {
        const parentId = cursor.header?.parentSession
        if (parentId === undefined || parentId === null || seen.has(parentId)) break
        const parent = sessions?.get?.(parentId)
        if (parent === undefined) break
        seen.add(parentId)
        root = parent
        cursor = parent
      }
    }

    const workspace = root.header?.cwd ?? own.header?.cwd
    const key = this.#options.scope === 'workspace'
      ? `w:${workspace ?? 'unknown'}`
      : `s:${root.id}`
    this.#scopeKeys.set(id, key)
    if (!this.#states.has(key)) this.#states.set(key, this.#blankState(key, workspace))
    return key
  }

  /**
   * Build an unloaded field state for one scope.
   * @param key - the scope key.
   * @param workspace - the scope root's working directory, when known.
   * @returns the state record.
   */
  #blankState(key, workspace) {
    const directory = this.#options.directory
    const file = directory !== '' && typeof workspace === 'string' && workspace.length > 0
      ? path.join(workspace, directory, `${key.replace(/[^A-Za-z0-9._-]/g, '_')}.jsonl`)
      : undefined
    return { key, file, entries: new Map(), loaded: false, mtimeMs: 0, size: -1, appends: 0 }
  }

  /**
   * Read the field's mirror when it changed underneath this process, so an
   * edit made by an ordinary file tool is picked up like any other trace.
   * @param key - the scope key.
   * @returns the field state, loaded when a mirror exists.
   */
  #state(key) {
    let state = this.#states.get(key)
    if (state === undefined) {
      state = this.#blankState(key, undefined)
      this.#states.set(key, state)
    }
    if (state.file === undefined) return state

    let stat
    try {
      stat = fs.statSync(state.file)
    } catch (error) {
      if (error?.code === 'ENOENT') state.loaded = true
      return state
    }
    // Windows can append without moving the timestamp forward, so size is part
    // of the freshness test; either changing means the file changed underneath.
    if (state.loaded && stat.mtimeMs === state.mtimeMs && stat.size === state.size) return state

    try {
      const text = fs.readFileSync(state.file, 'utf8')
      const entries = new Map()
      for (const line of text.split('\n')) {
        if (line.length === 0) continue
        let record
        try {
          record = JSON.parse(line)
        } catch {
          continue
        }
        if (record?.op === 'del' && typeof record.key === 'string') entries.delete(record.key)
        else if (record?.op === 'put') {
          const trace = readTrace(record.trace)
          if (trace !== undefined) entries.set(trace.key, trace)
        }
      }
      state.entries = entries
      state.loaded = true
      state.mtimeMs = stat.mtimeMs
      state.size = stat.size
    } catch (error) {
      this.#ctx.logger?.warn?.(`stigmergy: cannot read field mirror (${String(error)})`)
    }
    return state
  }

  /**
   * Live traces in one field, newest first.
   * @param key - the scope key.
   * @returns traces whose evaporation time has not passed.
   */
  list(key) {
    const state = this.#state(key)
    const now = Date.now()
    const live = []
    for (const trace of state.entries.values()) {
      if (typeof trace.expiresAt === 'number' && trace.expiresAt <= now) continue
      live.push(trace)
    }
    live.sort((left, right) => right.updatedAt - left.updatedAt || (left.key < right.key ? -1 : 1))
    return live
  }

  /**
   * Write or replace one trace. Replacing keeps `createdAt` and bumps `rev`, so
   * a another agent can tell an updated fact from a new one without a log.
   * @param key - the scope key.
   * @param input - the trace fields.
   * @returns the stored trace.
   */
  put(key, input) {
    const state = this.#state(key)
    const now = Date.now()
    const previous = state.entries.get(input.key)
    const ttl = input.ttlMinutes
    const trace = {
      key: input.key,
      title: input.title,
      detail: input.detail,
      kind: input.kind,
      author: input.author,
      role: input.role,
      from: input.from,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      rev: (previous?.rev ?? 0) + 1,
      expiresAt: ttl === 0 ? null : now + ttl * 60_000,
    }
    state.entries.set(trace.key, trace)
    this.#append(state, { v: 1, op: 'put', trace })
    return trace
  }

  /**
   * Retract one trace.
   * @param key - the scope key.
   * @param traceKey - the trace key to remove.
   * @returns whether a trace was removed.
   */
  remove(key, traceKey) {
    const state = this.#state(key)
    const existed = state.entries.delete(traceKey)
    if (existed) this.#append(state, { v: 1, op: 'del', key: traceKey })
    return existed
  }

  /**
   * Append one operation to the field's mirror. A failed write degrades the
   * field to memory-only for this process; it never fails the tool call.
   * @param state - the scope's field state.
   * @param record - the operation to persist.
   */
  #append(state, record) {
    if (state.file === undefined) return
    try {
      fs.mkdirSync(path.dirname(state.file), { recursive: true })
      fs.appendFileSync(state.file, `${JSON.stringify(record)}\n`, 'utf8')
      state.loaded = true
      state.appends += 1
      const written = fs.statSync(state.file)
      state.mtimeMs = written.mtimeMs
      state.size = written.size
      if (state.appends >= 200) this.#compact(state)
    } catch (error) {
      state.appends = 0
      this.#ctx.logger?.warn?.(`stigmergy: cannot write field mirror (${String(error)})`)
    }
  }

  /**
   * Rewrite the mirror as the live field, so evaporated and retracted traces do
   * not accumulate forever.
   * @param state - the scope's field state.
   */
  #compact(state) {
    try {
      const lines = this.list(state.key).map((trace) => JSON.stringify({ v: 1, op: 'put', trace }))
      fs.writeFileSync(state.file, lines.length === 0 ? '' : `${lines.join('\n')}\n`, 'utf8')
      state.appends = 0
      const written = fs.statSync(state.file)
      state.mtimeMs = written.mtimeMs
      state.size = written.size
    } catch (error) {
      this.#ctx.logger?.warn?.(`stigmergy: cannot compact field mirror (${String(error)})`)
    }
  }

  /**
   * Agents running in the same field right now, other than the caller.
   *
   * This is the automatic half of the field: nobody writes it. It is derived
   * from the live registry, so an agent learns that a peer has already taken
   * the work without a trace and without a message. It is deliberately not a
   * trace: it carries no meaning, only occupancy, and it disappears when the
   * peer does.
   *
   * @param scope - the field's scope key.
   * @param selfId - the calling agent, which is not a peer of itself.
   * @returns display names of the running peers.
   */
  peersOf(scope, selfId) {
    const agents = this.#ctx.get('agents')
    const peers = []
    for (const other of agents?.list?.() ?? []) {
      if (other?.id === undefined || other.id === selfId) continue
      if (other.status !== 'running') continue
      if (this.scopeKeyOf(other) !== scope) continue
      const identity = this.#identities.get(other.id)
      const short = shortId(other.id)
      if (identity === undefined) {
        // Resolve in the background; this render falls back to the id.
        this.warm(other)
        peers.push(short)
      } else if (identity.name === short) {
        peers.push(short)
      } else {
        peers.push(`"${identity.name}" (${short})`)
      }
    }
    return peers
  }

  /**
   * The bounded field snapshot injected into every step. Empty while nothing
   * has ever been left and nobody else is running, so a session that never uses
   * the field pays nothing.
   * @param agent - the agent whose step is being assembled.
   * @returns the model-facing snapshot, or an empty string.
   */
  summary(agent) {
    const scope = this.scopeKeyOf(agent)
    if (scope === undefined) return ''
    const traces = this.list(scope)
    const peers = this.peersOf(scope, agent?.id)
    if (traces.length === 0 && peers.length === 0) return ''

    const self = this.nameOf(agent)
    const shown = traces.slice(0, this.#options.maxEntries)
    const hidden = traces.length - shown.length
    const bullets = shown.map((trace) => {
      const title = clip(oneLine(trace.title), this.#options.maxTextChars)
      return `- [${trace.kind}] ${trace.key} · ${trace.author} · ${ago(trace.updatedAt)} — ${title}`
    })
    if (hidden > 0) bullets.push(`- ${hidden} more not shown; \`${READ}\` lists the whole field.`)

    const head = traces.length === 0
      ? `Shared field: nothing left here yet; you are ${self}.`
      : `Shared field: ${traces.length} trace${traces.length === 1 ? '' : 's'}; you are ${self}. `
        + `Other agents pick up a change on their next step — nothing is sent as a message. `
        + `Write or replace one with \`${LEAVE}\`; \`${READ}\` returns the detail behind a title.`

    const blocks = [head]
    if (peers.length > 0) blocks.push(`Working here now: ${peers.join(', ')}`)
    if (bullets.length > 0) blocks.push(bullets.join('\n'))
    return blocks.join('\n\n')
  }

  /**
   * The whole field, or a named subset, with each trace's detail. The snapshot
   * carries titles only, so this is where the evidence is fetched.
   * @param agent - the calling agent.
   * @param keys - restrict to these trace keys; omitted reads the whole field.
   * @returns the rendered field.
   */
  read(agent, keys) {
    const scope = this.scopeKeyOf(agent)
    if (scope === undefined) throw new Error(`${READ} requires an owning agent session`)
    const traces = this.list(scope)
    if (traces.length === 0) {
      return `The shared field is empty. \`${LEAVE}\` writes the first trace here.`
    }
    const wanted = Array.isArray(keys) && keys.length > 0 ? new Set(keys) : undefined
    const selected = wanted === undefined ? traces : traces.filter((trace) => wanted.has(trace.key))
    if (selected.length === 0) {
      const known = traces.map((trace) => trace.key).join(', ')
      return `No trace named ${[...wanted].map((key) => `\`${key}\``).join(', ')}. The field holds: ${known}.`
    }

    const blocks = selected.map((trace) => {
      const expiry = typeof trace.expiresAt === 'number'
        ? `expires in ${Math.max(0, Math.round((trace.expiresAt - Date.now()) / 60_000))}m`
        : 'does not evaporate'
      const body = trace.detail.trim().length === 0
        ? []
        : ['', ...trace.detail.split('\n').map((line) => `  ${line}`)]
      // The name is the point; the id is only worth repeating when it adds a
      // handle the name does not already carry, such as a teammate's session.
      const short = shortId(trace.from)
      const who = trace.author === short
        ? `${short} (${trace.role})`
        : `${trace.author} (${trace.role} ${short})`
      return [
        `[${trace.kind}] ${trace.key} — ${oneLine(trace.title)}`,
        `  from ${who}, updated ${ago(trace.updatedAt)} ago, rev ${trace.rev}, ${expiry}`,
        ...body,
      ].join('\n')
    })
    const hidden = traces.length - selected.length
    const head = `Shared field — ${selected.length} of ${traces.length} traces; you are ${shortId(agent?.id)}.`
    const tail = hidden > 0 ? `\n\n${hidden} other trace${hidden === 1 ? '' : 's'} not shown.` : ''
    return `${head}\n\n${blocks.join('\n\n')}${tail}`
  }
}

/**
 * Normalize a trace key: trimmed, bounded, and non-empty. Keys are what
 * another agent names to replace a trace, so they must be memorable.
 * @param value - the model-supplied key.
 * @returns the canonical key.
 */
function traceKey(value) {
  if (typeof value !== 'string') throw new Error('`key` must be a string')
  const key = value.trim()
  if (key.length === 0) throw new Error('`key` must be a non-empty string')
  if (key.length > 120) throw new Error('`key` must be at most 120 characters')
  return key
}

/**
 * Build one text-returning tool definition. A string output keeps the schema
 * trivial and the model-facing result exactly the rendered text.
 * @param definition - name, description, parameter schema, execute, and optional call card.
 * @returns a registry-ready definition.
 */
function textTool(definition) {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    ...definition.presentCall === undefined ? {} : { presentCall: definition.presentCall },
    execute: definition.execute,
  }
}

/**
 * Register the field's tools, its standing protocol, and its live snapshot.
 * @param ctx - the plugin context.
 * @param config - the row's config.
 */
export function apply(ctx, config) {
  const options = normalizeConfig(config)
  const field = new Field(ctx, options)

  const leave = textTool({
    name: LEAVE,
    description:
      'Write or replace one trace in the shared field that the other agents in this session read before each of their steps. '
      + 'Use it to publish a decision, a finding, a claim on a file, a handoff, or a blocker instead of messaging: the trace reaches them on their own next step, with no sender, no recipient, and no relay. '
      + '`key` names the trace, so writing the same key replaces the previous one and the field stays current state rather than a log. '
      + 'Split each trace in two: `title` is what every agent pays for on every step and must let them decide whether to look closer; `detail` is the evidence — the commands, the exact paths — and is read only on request. '
      + 'Write the title for someone deciding whether they need the detail, not as a summary of it.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['key', 'title'],
      properties: {
        key: {
          type: 'string',
          description: 'Stable trace key the other agents can name again, such as `auth/schema` or `parse/csv`. Writing it again replaces the trace.',
        },
        title: {
          type: 'string',
          description: `One line, at most ${TITLE_LIMIT} characters: the fact, the decision, or the next step, phrased so another agent can tell whether it concerns them. This is all they see by default.`,
        },
        detail: {
          type: 'string',
          description: `The evidence behind the title: paths, commands, numbers, caveats. Only read when someone asks for it. At most ${DETAIL_LIMIT} characters; omit when the title says everything.`,
        },
        kind: {
          type: 'string',
          enum: [...KINDS],
          description: `What kind of trace this is; defaults to \`note\`. ${KINDS.join(' | ')}.`,
        },
        author: {
          type: 'string',
          description: 'Override the name other agents attribute the trace to. By default it is your Team member name, or the label your parent gave this subagent; a session id suffix is only the last resort.',
        },
        ttl_minutes: {
          type: 'integer',
          description: `Minutes before the trace evaporates; 0 keeps it until replaced. Defaults to ${options.defaultTtlMinutes}.`,
        },
      },
    },
    presentCall: (args) => (typeof args?.key === 'string'
      ? { card: 'generic', title: `Leave trace · ${args.key}`, kind: 'other' }
      : undefined),
    execute: async (args, exec) => {
      const agent = exec?.agent
      if (agent === undefined) throw new Error(`${LEAVE} requires an owning agent session`)
      const scope = field.scopeKeyOf(agent)
      if (scope === undefined) throw new Error(`${LEAVE} cannot resolve this agent's field`)

      const identity = await field.identify(agent)
      const key = traceKey(args?.key)
      const title = typeof args?.title === 'string' ? oneLine(args.title) : ''
      if (title.length === 0) throw new Error('`title` must be a non-empty string')
      if (title.length > TITLE_LIMIT) throw new Error(`\`title\` must be at most ${TITLE_LIMIT} characters; move the rest into \`detail\``)
      const detail = typeof args?.detail === 'string' ? args.detail.trim() : ''
      if (detail.length > DETAIL_LIMIT) throw new Error(`\`detail\` must be at most ${DETAIL_LIMIT} characters`)
      // Reject an unknown kind instead of quietly storing `note`: the field is
      // shared state, so what a caller believes it wrote must be what others read.
      const kind = args?.kind === undefined ? 'note' : args.kind
      if (!KINDS.includes(kind)) throw new Error(`\`kind\` must be one of: ${KINDS.join(', ')}`)
      const author = typeof args?.author === 'string' && args.author.trim().length > 0
        ? args.author.trim().slice(0, 40)
        : identity.name
      let ttlMinutes = options.defaultTtlMinutes
      if (args?.ttl_minutes !== undefined) {
        const requested = Number(args.ttl_minutes)
        if (!Number.isFinite(requested)) throw new Error('`ttl_minutes` must be a number')
        ttlMinutes = integer(requested, options.defaultTtlMinutes, 0, 10080)
      }

      const trace = field.put(scope, {
        key,
        title,
        detail,
        kind,
        author,
        role: identity.role,
        from: agent.id,
        ttlMinutes,
      })
      const total = field.list(scope).length
      const mine = field.list(scope).filter((entry) => entry.from === agent.id).length
      const hasDetail = detail.length === 0 ? 'no detail' : `${detail.length} characters of detail`
      return `Left trace \`${key}\` as ${author} (${identity.role}), ${kind}, rev ${trace.rev}, ${hasDetail}; the field now holds ${total} trace${total === 1 ? '' : 's'}, ${mine} of them yours. `
        + 'Other agents see the title on their next step without any message; they read the detail only if they ask for it.'
    },
  })

  const read = textTool({
    name: READ,
    description:
      'Read the shared field, or the detail behind one or more traces. '
      + `Every title is already in your runtime context before each step; call this when a title is cut short, when the trace you need has fallen outside the summary, or when you want the evidence behind a title before acting on it.`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Trace keys whose detail to read; omit to read the whole field.',
        },
      },
    },
    presentCall: (args) => (Array.isArray(args?.keys) && args.keys.length > 0
      ? { card: 'generic', title: `Read traces · ${args.keys.join(', ')}`, kind: 'read' }
      : { card: 'generic', title: 'Read shared field', kind: 'read' }),
    execute(args, exec) {
      const agent = exec?.agent
      if (agent === undefined) throw new Error(`${READ} requires an owning agent session`)
      const keys = Array.isArray(args?.keys)
        ? args.keys.filter((key) => typeof key === 'string').map((key) => key.trim()).filter((key) => key.length > 0)
        : undefined
      return field.read(agent, keys)
    },
  })

  const clear = textTool({
    name: CLEAR,
    description:
      'Retract one trace from the shared field before it evaporates. '
      + 'Use it when the trace is wrong, when the work it described is finished, or when another trace now supersedes it.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['key'],
      properties: {
        key: {
          type: 'string',
          description: 'The exact trace key to remove.',
        },
      },
    },
    presentCall: (args) => (typeof args?.key === 'string'
      ? { card: 'generic', title: `Retract trace · ${args.key}`, kind: 'other' }
      : undefined),
    execute(args, exec) {
      const agent = exec?.agent
      if (agent === undefined) throw new Error(`${CLEAR} requires an owning agent session`)
      const scope = field.scopeKeyOf(agent)
      if (scope === undefined) throw new Error(`${CLEAR} cannot resolve this agent's field`)
      const key = traceKey(args?.key)
      const removed = field.remove(scope, key)
      const total = field.list(scope).length
      return removed
        ? `Retracted trace \`${key}\`; the field now holds ${total} trace${total === 1 ? '' : 's'}.`
        : `No trace named \`${key}\`; nothing changed. The field holds ${total} trace${total === 1 ? '' : 's'}.`
    },
  })

  ctx.tools.register(leave)
  ctx.tools.register(read)
  ctx.tools.register(clear)

  // Presence is rendered from live state, so a peer's name has to be resolved
  // before it can be shown. Resolving costs one parent-catalog read and is
  // cached; it is started here and never blocks the child's creation.
  ctx.on('agent/created', ({ agent: created }) => {
    field.warm(created)
  })

  if (options.promptSection) {
    ctx.systemPrompt.section({
      name: 'stigmergy:protocol',
      order: PROTOCOL_SECTION_ORDER,
      text: (context) => (ctx.tools.get(LEAVE, context?.scope) === leave ? PROTOCOL : ''),
    })
  }

  ctx.systemPrompt.context({
    name: 'stigmergy:field',
    order: FIELD_CONTEXT_ORDER,
    text: (context) => {
      if (context?.agent === undefined || ctx.tools.get(LEAVE, context.scope) !== leave) return ''
      try {
        return field.summary(context.agent)
      } catch (error) {
        ctx.logger?.warn?.(`stigmergy: cannot render field (${String(error)})`)
        return ''
      }
    },
  })
}

export { normalizeConfig }
