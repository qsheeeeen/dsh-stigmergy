# Stigmergy for DeepSeek Harness

A shared trace field for a delegation tree: agents coordinate by changing a common environment instead of messaging each other.

Inspired by biological stigmergy — an ant never tells another ant where the food is. It lays a pheromone trail, and any ant that later walks there simply follows it. The information lives in the environment, not in a message.

## Why

Multi-agent systems usually fail by copying the human org chart: report, align, approve. Double the agents and peer-to-peer chatter quadruples. AI-native coordination looks different: share one live context, change the state, leave a trace, let the next step react.

This plugin gives one delegation tree — the main agent plus every subagent it starts, at any depth — a shared trace field:

- every agent sees the current field in its runtime context before every step, bounded and evaporating;
- a trace one agent leaves is already in a peer's next step: no `send_message`, no parent relaying, no N² message graph;
- a trace is a slot identified by `key`, so writing it again replaces it and the field stays current state rather than a chat log;
- each trace is split in two: a short `title` every peer pays for on every step, and a `detail` paid only when someone asks for it;
- traces evaporate (90 minutes by default), so stale information removes itself without anyone cleaning up.

## Install

```powershell
git clone https://github.com/qsheeeeen/dsh-stigmergy
```

Then in DSH, `plugin_manager` → `install_bundle` with the cloned directory as target (or install it from Creator mode), and restart DSH.

## Tools

| Tool | What it does |
| --- | --- |
| `stigmergy_leave` | Write or replace one trace: `key` (the slot), `title` (one line, ≤ 160 chars), `detail` (optional, ≤ 4000 chars), `kind`, `author`, `ttl_minutes` |
| `stigmergy_read` | Read the detail behind one or more `keys`, or the whole field |
| `stigmergy_clear` | Retract a trace before it evaporates |

`kind` is one of `note`, `decision`, `finding`, `task`, `question`, `done`.

### Why a title and a detail

Write is cheap and read is not: every peer re-reads the field on every step. So the part that enters every step — the title — has to earn its place by letting a peer decide whether the trace concerns them at all. The evidence behind it — paths, commands, numbers, caveats — stays out of every step and is fetched only when a peer asks.

A good title is not a summary of the detail. It is the one thing that changes a peer's next action if true.

## How it works

1. **One field per colony.** With `scope: tree` (the default) the colony is the root session of the delegation tree, so a parent and all of its descendants share a field. With `scope: workspace` the working directory is the colony instead, and separate conversations in one project share a field.
2. **Injection.** A `systemPrompt.context` renders the field into the runtime context while the request is assembled — titles only. DSH recomputes runtime context for every request, so the field is live rather than a snapshot taken at startup.
3. **Persistence.** The field is mirrored to `<cwd>/.dsh-stigmergy/<colony>.jsonl`. It survives a restart, ordinary `read` and `grep` can inspect it, and an edit made outside the plugin is adopted on the next read.
4. **Evaporation.** `expiresAt` drops a trace out of the field; the mirror is compacted every 200 appends.
5. **Identity.** Every trace carries a stable `from` (the session id) and a display `author`. The display name is resolved automatically, because the two coordination modes have different durable identities:
   - **Agent Team** — the roster name from `agentTeams.tryMembership`, which is what peers already address.
   - **Standard delegation** — the label the parent chose when it started the child, read once from the parent's catalog (`subagents.listChildren`).
   - Neither — the session id suffix, and nothing better is invented.

   The raw id stays on the trace and appears in `read`, because that is what `list_agents` shows a parent. `author` can override the resolved name when a role matters more than a name.

## Configuration

`config` in `cordis.patch.yml`, overridable from your own profile patch layer:

| Field | Default | Meaning |
| --- | --- | --- |
| `directory` | `.dsh-stigmergy` | Mirror directory, relative to the colony root's working directory; `""` keeps the field in memory only |
| `scope` | `tree` | `tree` (one delegation tree) or `workspace` (one working directory) |
| `maxEntries` | `12` | Most traces rendered into the context snapshot |
| `maxTextChars` | `280` | Defensive cap on each title in the snapshot (titles are already ≤ 160) |
| `defaultTtlMinutes` | `90` | Default evaporation time; `0` keeps a trace until it is replaced |
| `promptSection` | `true` | Whether to add the standing coordination paragraph to the system prompt |

## Verification

```powershell
node test/check.mjs
```

A regression check over a fake Cordis context. It covers: sharing inside a tree, isolation across trees, the title/detail split, slot replacement, enforced bounds, retraction, replay from the mirror, migration of an older record, adoption of external edits, identity resolution in both coordination modes, and config normalization.

Live records:

1. The parent wrote `demo/handoff`; a child sitting in `Start-Sleep` saw it in its next runtime snapshot — without calling `stigmergy_read` and without receiving any message.
2. A child wrote `demo/decision`; it appeared in the parent's next runtime context.
3. Two sibling subagents running in parallel each saw the other's trace after a 45-second wait, again without reading it.
4. Retracting a trace removed it from another agent's next step.

## Boundaries

- The tools are registered globally, and preset scoping still applies: a preset that masks global tools hides the field from that agent, while a child that inherits globals still sees it. The plugin knows nothing about, and depends on, no specific preset.
- The field is for agents running in the same tree. It does not replace a subagent's final report, which still returns to its parent; the field is the peer-to-peer layer.
- The mirror is written by the Host process directly, outside the model's tool sandbox. A failed write degrades the field to memory-only instead of failing the tool call.

## License

[MIT](LICENSE)
