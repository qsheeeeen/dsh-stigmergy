# Stigmergy for DeepSeek Harness

A shared field of traces for a session: its agents coordinate by changing one common environment instead of messaging each other.

Inspired by biological stigmergy — an ant never tells another ant where the food is. It leaves a pheromone trail, and any ant that later walks there follows it. The information lives in the environment, not in a message.

## Why

Multi-agent systems usually copy the human org chart: report, align, approve. Double the agents and the chatter quadruples. AI-native coordination looks different: share one live context, change the state, leave a trace, let the next step react.

This plugin gives one session — the main agent and every subagent under it, at any depth — a shared field of traces:

- every agent sees the field in its runtime context before every step, bounded and evaporating;
- a trace one agent leaves is already in another agent's next step: no `send_message`, no parent relaying, no N² message graph;
- a trace is identified by `key`, so writing it again replaces it and the field stays current state rather than a chat log;
- each trace is split in two: a short `title` every agent pays for on every step, and a `detail` paid only when someone asks for it;
- traces evaporate (90 minutes by default), so stale information removes itself.

## Install

```powershell
git clone https://github.com/qsheeeeen/dsh-stigmergy
```

Then in DSH, `plugin_manager` → `install_bundle` with the cloned directory as target (or install it from Creator mode), and restart DSH.

## Tools

| Tool | What it does |
| --- | --- |
| `stigmergy_leave` | Write or replace one trace: `key`, `title` (one line, ≤ 160 chars), `detail` (optional, ≤ 4000 chars), `kind`, `author`, `ttl_minutes` |
| `stigmergy_read` | Read the detail behind one or more `keys`, or the whole field |
| `stigmergy_clear` | Remove a trace before it evaporates |

`kind` is one of `note`, `decision`, `finding`, `task`, `question`, `done`.

### Why a title and a detail

Write is cheap and read is not: every agent re-reads the field on every step. So the part that enters every step — the title — has to earn its place by telling an agent whether the trace concerns it at all. The evidence behind it — paths, commands, numbers, caveats — stays out of every step and is fetched only on request.

A good title is not a summary of the detail. It is the one thing that changes an agent's next action if true.

## How it works

1. **One field per scope.** With `scope: session` (the default) the scope is the root session of the subagent tree, so a parent and all of its descendants share one field. With `scope: workspace` the working directory is the scope instead, and separate conversations in one project share a field.
2. **Injection.** A `systemPrompt.context` renders the field into the runtime context while the request is assembled — titles only. DSH recomputes runtime context for every request, so the field is live rather than a snapshot taken at startup.
3. **Persistence.** The field is mirrored to `<cwd>/.dsh-stigmergy/<scope>.jsonl`. It survives a restart, ordinary `read` and `grep` can inspect it, and an edit made outside the plugin is adopted on the next read.
4. **Evaporation.** `expiresAt` drops a trace out of the field; the mirror is compacted every 200 appends.
5. **Identity.** Every trace carries a stable `from` (the session id) and a display `author`. The display name is resolved automatically, because the two coordination modes have different durable identities:
   - **Agent Team** — the roster name from `agentTeams.tryMembership`, which is what the other agents already address.
   - **Standard delegation** — the label the parent chose when it started the child, read once from the parent's catalog (`subagents.listChildren`).
   - Neither — the session id suffix, and nothing better is invented.

   The raw id stays on the trace and appears in `read`, because that is what `list_agents` shows a parent. `author` can override the resolved name when a role matters more than a name.

The mirror is append-only JSONL, one operation per line:

```json
{"v":1,"op":"put","trace":{"key":"auth/schema","title":"…","detail":"…","kind":"decision","author":"parser","role":"teammate","from":"session-…","createdAt":0,"updatedAt":0,"rev":1,"expiresAt":0}}
{"v":1,"op":"del","key":"auth/schema"}
```

The shape is exact. A line missing any trace field is dropped rather than repaired, because a half-written record would otherwise enter a field that every agent reads on every step.

## Configuration

`config` in `cordis.patch.yml`, overridable from your own profile patch layer:

| Field | Default | Meaning |
| --- | --- | --- |
| `directory` | `.dsh-stigmergy` | Mirror directory, relative to the scope's working directory; `""` keeps the field in memory only |
| `scope` | `session` | `session` (one session and its subagent tree) or `workspace` (one working directory) |
| `maxEntries` | `12` | Most traces rendered into the context snapshot |
| `maxTextChars` | `280` | Defensive cap on each title in the snapshot (titles are already ≤ 160) |
| `defaultTtlMinutes` | `90` | Default evaporation time; `0` keeps a trace until it is replaced |
| `promptSection` | `true` | Whether to add the standing coordination paragraph to the system prompt |

## Verification

```powershell
node test/check.mjs
```

A regression check over a fake Cordis context. It covers: sharing inside a session, isolation across sessions, the title/detail split, trace replacement, enforced bounds, removal, replay from the mirror, rejection of a partial mirror record, adoption of a complete external one, identity resolution in both coordination modes, and config normalization.

Live records:

1. The parent wrote `demo/handoff`; a child sitting in `Start-Sleep` saw it in its next runtime snapshot — without calling `stigmergy_read` and without receiving any message.
2. A child wrote `demo/decision`; it appeared in the parent's next runtime context.
3. Two sibling subagents running in parallel each saw the other's trace after a 45-second wait, again without reading it.
4. Removing a trace dropped it from another agent's next step.

## Boundaries

- The tools are registered globally, and preset scoping still applies: a preset that masks global tools hides the field from that agent, while a child that inherits globals still sees it. The plugin knows nothing about, and depends on, no specific preset.
- The field is for agents running in the same session. It does not replace a subagent's final report, which still returns to its parent; the field is the shared layer.
- The mirror is written by the Host process directly, outside the model's tool sandbox. A failed write degrades the field to memory-only instead of failing the tool call.

## License

[MIT](LICENSE)
