/**
 * Stigmergy — coordination through a shared environment instead of messages.
 *
 * An ant does not tell another ant where the food is. It changes the
 * environment: it lays a pheromone trail, and any ant that later walks there
 * follows it. The trace carries the information, so there is no sender, no
 * recipient, and no rendezvous. Biologists call this stigmergy.
 *
 * This plugin gives one delegation tree the same mechanism. Every agent in the
 * tree — the parent and all of its subagents — reads one bounded, evaporating
 * field of traces. The field is rendered into each agent's runtime context
 * before every model request, so a trace one agent leaves is already in a
 * peer's next step: no `send_message`, no parent relaying, and no N² message
 * graph.
 *
 * The surfaces are three tools:
 *   - `stigmergy_leave` writes or replaces one trace; `key` names the slot,
 *     so the field stays current state rather than a chat log.
 *   - `stigmergy_read` returns the field, or the full text of named traces.
 *   - `stigmergy_clear` retracts a trace before it evaporates.
 *
 * The field is mirrored to `<cwd>/.dsh-stigmergy/<colony>.jsonl`, so it
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
  'Coordination here is stigmergic: every agent in this delegation tree shares one trace field',
  '(`stigmergy_leave`, `stigmergy_read`, `stigmergy_clear`) that is read before each of your steps.',
  'Publish what a peer needs — a decision, a finding, a claim, a handoff, a blocker — by changing the',
  'field instead of sending a message; peers pick it up on their own next step. Read the field before',
  'you redo work someone else may have already started.',
].join(' ')

/** Defaults for every tunable; `cordis.patch.yml` overrides them per profile. */
const DEFAULTS = Object.freeze({
  directory: '.dsh-stigmergy',
  scope: 'tree',
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
    scope: config.scope === 'workspace' ? 'workspace' : 'tree',
    maxEntries: integer(config.maxEntries, DEFAULTS.maxEntries, 1, 50),
    maxTextChars: integer(config.maxTextChars, DEFAULTS.maxTextChars, 60, 2000),
    defaultTtlMinutes: integer(config.defaultTtlMinutes, DEFAULTS.defaultTtlMinutes, 0, 10080),
    promptSection: config.promptSection !== false,
  }
}

/**
 * Whether a value read back from disk is a trace this version understands.
 * @param value - a parsed JSONL record payload.
 * @returns whether it carries the required fields.
 */
function isTrace(value) {
  return value !== null
    && typeof value === 'object'
    && typeof value.key === 'string'
    && typeof value.text === 'string'
    && typeof value.updatedAt === 'number'
}

/**
 * One delegation tree's shared field: the traces plus the colony each one
 * belongs to, backed by an append-only JSONL mirror under the tree's working
 * directory.
 */
class Field {
  /** @type {ReturnType<typeof normalizeConfig>} */
  #options
  /** @type {import('@deepseek-ai/cordis').Context} */
  #ctx
  /** colony key → field state. @type {Map<string, {key: string, file: string | undefined, entries: Map<string, object>, loaded: boolean, mtimeMs: number, appends: number}>} */
  #states = new Map()
  /** agent id → colony key. @type {Map<string, string>} */
  #colonies = new Map()

  /**
   * @param ctx - the plugin context, for optional services and diagnostics.
   * @param options - normalized plugin options.
   */
  constructor(ctx, options) {
    this.#ctx = ctx
    this.#options = options
  }

  /**
   * Resolve the colony an agent belongs to. A colony is the root of the
   * delegation tree the agent was spawned in, so a parent and all of its
   * descendants — however deep — smell the same field. In `workspace` scope
   * the working directory is the colony instead, so separate conversations in
   * one project share a field.
   *
   * Resolution walks live ancestor sessions, because a child's header names its
   * parent and the parent is alive while its child is. When an ancestor is
   * already gone the chain stops at the nearest live session, which keeps the
   * key stable for the agents that are still running.
   *
   * @param agent - the calling agent.
   * @returns the colony key, or undefined when the agent has no session.
   */
  colonyOf(agent) {
    const id = agent?.id
    const own = agent?.session
    if (typeof id !== 'string' || own === undefined || own === null) return undefined

    const cached = this.#colonies.get(id)
    if (cached !== undefined) return cached

    const sessions = this.#ctx.get('sessions')
    let root = own
    if (this.#options.scope === 'tree') {
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
      : `t:${root.id}`
    this.#colonies.set(id, key)
    if (!this.#states.has(key)) this.#states.set(key, this.#blankState(key, workspace))
    return key
  }

  /**
   * Build an unloaded field state for one colony.
   * @param key - the colony key.
   * @param workspace - the colony root's working directory, when known.
   * @returns the state record.
   */
  #blankState(key, workspace) {
    const directory = this.#options.directory
    const file = directory !== '' && typeof workspace === 'string' && workspace.length > 0
      ? path.join(workspace, directory, `${key.replace(/[^A-Za-z0-9._-]/g, '_')}.jsonl`)
      : undefined
    return { key, file, entries: new Map(), loaded: false, mtimeMs: 0, appends: 0 }
  }

  /**
   * Read the colony's mirror when it changed underneath this process, so an
   * edit made by an ordinary file tool is picked up like any other trace.
   * @param key - the colony key.
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
    if (state.loaded && stat.mtimeMs === state.mtimeMs) return state

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
        else if (record?.op === 'put' && isTrace(record.trace)) entries.set(record.trace.key, record.trace)
      }
      state.entries = entries
      state.loaded = true
      state.mtimeMs = stat.mtimeMs
    } catch (error) {
      this.#ctx.logger?.warn?.(`stigmergy: cannot read field mirror (${String(error)})`)
    }
    return state
  }

  /**
   * Live traces in one colony, newest first.
   * @param key - the colony key.
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
   * a peer can tell an updated fact from a new one without a log.
   * @param key - the colony key.
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
      text: input.text,
      kind: input.kind,
      author: input.author,
      from: String(input.from ?? ''),
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
   * @param key - the colony key.
   * @param traceKey - the slot to remove.
   * @returns whether a trace was removed.
   */
  remove(key, traceKey) {
    const state = this.#state(key)
    const existed = state.entries.delete(traceKey)
    if (existed) this.#append(state, { v: 1, op: 'del', key: traceKey })
    return existed
  }

  /**
   * Append one operation to the colony's mirror. A failed write degrades the
   * field to memory-only for this process; it never fails the tool call.
   * @param state - the colony's field state.
   * @param record - the operation to persist.
   */
  #append(state, record) {
    if (state.file === undefined) return
    try {
      fs.mkdirSync(path.dirname(state.file), { recursive: true })
      fs.appendFileSync(state.file, `${JSON.stringify(record)}\n`, 'utf8')
      state.loaded = true
      state.appends += 1
      state.mtimeMs = fs.statSync(state.file).mtimeMs
      if (state.appends >= 200) this.#compact(state)
    } catch (error) {
      state.appends = 0
      this.#ctx.logger?.warn?.(`stigmergy: cannot write field mirror (${String(error)})`)
    }
  }

  /**
   * Rewrite the mirror as the live field, so evaporated and retracted traces do
   * not accumulate forever.
   * @param state - the colony's field state.
   */
  #compact(state) {
    try {
      const lines = this.list(state.key).map((trace) => JSON.stringify({ v: 1, op: 'put', trace }))
      fs.writeFileSync(state.file, lines.length === 0 ? '' : `${lines.join('\n')}\n`, 'utf8')
      state.appends = 0
      state.mtimeMs = fs.statSync(state.file).mtimeMs
    } catch (error) {
      this.#ctx.logger?.warn?.(`stigmergy: cannot compact field mirror (${String(error)})`)
    }
  }

  /**
   * The bounded field snapshot injected into every step. Empty while nothing
   * has ever been left, so a tree that does not use the field pays nothing.
   * @param agent - the agent whose step is being assembled.
   * @returns the model-facing snapshot, or an empty string.
   */
  summary(agent) {
    const colony = this.colonyOf(agent)
    if (colony === undefined) return ''
    const traces = this.list(colony)
    if (traces.length === 0) return ''

    const shown = traces.slice(0, this.#options.maxEntries)
    const hidden = traces.length - shown.length
    const self = shortId(agent?.id)
    const lines = shown.map((trace) => {
      const text = clip(oneLine(trace.text), this.#options.maxTextChars)
      return `- [${trace.kind}] ${trace.key} · ${trace.author} · ${ago(trace.updatedAt)} — ${text}`
    })
    const head = `Shared field (stigmergy): ${traces.length} trace${traces.length === 1 ? '' : 's'}; you are ${self}. `
      + `Peers pick up a change on their next step — nothing is sent as a message. `
      + `Write or replace one with \`${LEAVE}\`; \`${READ}\` returns full text.`
    return hidden === 0
      ? [head, '', ...lines].join('\n')
      : [head, '', ...lines, `- ${hidden} more not shown; \`${READ}\` lists the whole field.`].join('\n')
  }

  /**
   * The full, untruncated field or a named subset, for a caller that needs the
   * exact text.
   * @param agent - the calling agent.
   * @param keys - restrict to these slots; omitted reads the whole field.
   * @returns the rendered field.
   */
  read(agent, keys) {
    const colony = this.colonyOf(agent)
    if (colony === undefined) throw new Error(`${READ} requires an owning agent session`)
    const traces = this.list(colony)
    if (traces.length === 0) {
      return `The shared field is empty. \`${LEAVE}\` writes the first trace for this delegation tree.`
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
      return [
        `[${trace.kind}] ${trace.key}`,
        `  from ${trace.author}, updated ${ago(trace.updatedAt)} ago, rev ${trace.rev}, ${expiry}`,
        ...trace.text.split('\n').map((line) => `  ${line}`),
      ].join('\n')
    })
    const hidden = traces.length - selected.length
    const head = `Shared field (${colony}) — ${selected.length} of ${traces.length} traces; you are ${shortId(agent?.id)}.`
    const tail = hidden > 0 ? `\n\n${hidden} other trace${hidden === 1 ? '' : 's'} not shown.` : ''
    return `${head}\n\n${blocks.join('\n\n')}${tail}`
  }
}

/**
 * Normalize a trace key: trimmed, bounded, and non-empty. Keys are the slot a
 * peer replaces, so they must be memorable enough to name again.
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
      'Write or replace one trace in the shared field that every agent in this delegation tree reads before each of its steps. '
      + 'Use it to publish a decision, a finding, a claim on a file, a handoff, or a blocker instead of messaging a peer: the trace reaches them on their own next step, with no sender, no recipient, and no relay. '
      + '`key` names the slot, so writing the same key replaces the previous text and the field stays current state rather than a log. '
      + 'Keep `text` dense: peers re-read the whole field on every step, so write only what changes their next action.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['key', 'text'],
      properties: {
        key: {
          type: 'string',
          description: 'Stable slot id a peer can name again, such as `auth/schema` or `parse/csv`. Writing it again replaces the trace.',
        },
        text: {
          type: 'string',
          description: 'What peers must know to act, in one to three sentences. Not a status report: the fact, the decision, or the next step.',
        },
        kind: {
          type: 'string',
          enum: [...KINDS],
          description: `What kind of trace this is; defaults to \`note\`. ${KINDS.join(' | ')}.`,
        },
        author: {
          type: 'string',
          description: 'Short label peers can attribute the trace to; defaults to the caller session id suffix.',
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
    execute(args, exec) {
      const agent = exec?.agent
      if (agent === undefined) throw new Error(`${LEAVE} requires an owning agent session`)
      const colony = field.colonyOf(agent)
      if (colony === undefined) throw new Error(`${LEAVE} cannot resolve this agent's delegation tree`)

      const key = traceKey(args?.key)
      const text = typeof args?.text === 'string' ? args.text.trim() : ''
      if (text.length === 0) throw new Error('`text` must be a non-empty string')
      // Reject an unknown kind instead of quietly storing `note`: the field is
      // shared state, so what a caller believes it wrote must be what peers read.
      const kind = args?.kind === undefined ? 'note' : args.kind
      if (!KINDS.includes(kind)) throw new Error(`\`kind\` must be one of: ${KINDS.join(', ')}`)
      const author = typeof args?.author === 'string' && args.author.trim().length > 0
        ? args.author.trim().slice(0, 40)
        : shortId(agent.id)
      let ttlMinutes = options.defaultTtlMinutes
      if (args?.ttl_minutes !== undefined) {
        const requested = Number(args.ttl_minutes)
        if (!Number.isFinite(requested)) throw new Error('`ttl_minutes` must be a number')
        ttlMinutes = integer(requested, options.defaultTtlMinutes, 0, 10080)
      }

      const trace = field.put(colony, {
        key,
        text: text.slice(0, 4000),
        kind,
        author,
        from: agent.id,
        ttlMinutes,
      })
      const total = field.list(colony).length
      const mine = field.list(colony).filter((entry) => entry.from === agent.id).length
      return `Left trace \`${key}\` (${kind}, rev ${trace.rev}); the field now holds ${total} trace${total === 1 ? '' : 's'}, ${mine} of them yours. `
        + 'Peers see it on their next step without any message.'
    },
  })

  const read = textTool({
    name: READ,
    description:
      'Read the shared field of this delegation tree, or the full text of named traces. '
      + `The field is already summarized in your runtime context before every step; call this when a summary was truncated, when a trace you need has fallen outside the summary, or when you want to check the field before redoing work someone else may have started.`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Slots to read in full; omit to read the whole field.',
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
          description: 'The exact slot to remove.',
        },
      },
    },
    presentCall: (args) => (typeof args?.key === 'string'
      ? { card: 'generic', title: `Retract trace · ${args.key}`, kind: 'other' }
      : undefined),
    execute(args, exec) {
      const agent = exec?.agent
      if (agent === undefined) throw new Error(`${CLEAR} requires an owning agent session`)
      const colony = field.colonyOf(agent)
      if (colony === undefined) throw new Error(`${CLEAR} cannot resolve this agent's delegation tree`)
      const key = traceKey(args?.key)
      const removed = field.remove(colony, key)
      const total = field.list(colony).length
      return removed
        ? `Retracted trace \`${key}\`; the field now holds ${total} trace${total === 1 ? '' : 's'}.`
        : `No trace named \`${key}\`; nothing changed. The field holds ${total} trace${total === 1 ? '' : 's'}.`
    },
  })

  ctx.tools.register(leave)
  ctx.tools.register(read)
  ctx.tools.register(clear)

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
