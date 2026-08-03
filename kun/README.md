# Kun

Kun is the local HTTP/SSE agent runtime for DeepSeek-GUI. It exposes a
TypeScript-typed agent loop with a stable, GUI-friendly contract:

- `kun serve` starts a local HTTP server with `/v1/*` routes.
- Threads, turns, events, approvals, and usage are persisted as append-only
  JSONL logs with atomic index updates.
- The loop is cache-first by construction: immutable prompt prefix, bounded
  TTL/LRU caches, inflight tracking, and explicit context compaction.

The name Kun is inspired by the great fish in Zhuangzi's line,
"In the northern sea there is a fish; its name is Kun." In
DeepSeek-GUI, it means a deeper local runtime rather than a thin model
UI: one agent loop that can carry project context, call tools
reliably, resume sessions, and serve desktop chat, writing, phone
connections, and scheduled tasks.

Kun's core goal is to improve the ROI of every token. Tokens should be
spent on user requirements, code, decisions, and results, not repeated
tool schemas, runaway tool output, malformed history, useless retries,
or stable prefixes that could have been reused from cache.

## Layout

```
kun/
  src/
    cli/         Command-line entrypoints (serve, run, chat, exec)
    contracts/   Zod schemas and inferred types for the HTTP/SSE contract
    domain/      Thread, Turn, Item, Event, Approval, Usage entities
    ports/       ModelClient, ToolHost, stores, EventBus, ApprovalGate, ...
    adapters/    DeepSeek-compatible model client, local tool host,
                 in-memory and file-backed stores, workspace inspector
    services/    Thread and turn orchestration services
    loop/        The cache-first agent loop and inflight helpers
    cache/       LRU / TTL caches and immutable prefix utilities
    telemetry/   Usage, cache, and cost counters
    server/      HTTP routing, auth, SSE, response helpers
  tests/         Cross-cutting contract tests
  dist/          Build output (gitignored)
```

## Scripts

Run from the `kun/` directory.

- `npm run typecheck` – run the package typecheck (no emit).
- `npm run test` – run Vitest unit and contract tests.
- `npm run build` – emit ESM JavaScript and type declarations into `dist/`.
- `npm run serve` – start the runtime after a build.
- `npm run dev` – rebuild in watch mode.

## CLI

`kun serve` accepts the following flags:

| Flag | Description | Default |
| --- | --- | --- |
| `--config` | JSON config file. If omitted, Kun reads `{--data-dir}/config.json` when present | optional |
| `--host` | Bind address | `127.0.0.1` |
| `--port` | HTTP port | `8899` |
| `--data-dir` | Root directory for threads, events, and usage | required |
| `--runtime-token` | Bearer token for `/v1/*` requests | empty |
| `--api-key` | DeepSeek-compatible API key | empty |
| `--base-url` | DeepSeek-compatible model API base URL | `https://api.deepseek.com/beta` |
| `--model` | Default model id | `deepseek-v4-pro` |
| `--approval-policy` | `on-request` \| `untrusted` \| `never` \| `auto` \| `suggest` | `auto` |
| `--sandbox-mode` | `read-only` \| `workspace-write` \| `danger-full-access` \| `external-sandbox` | `workspace-write` |
| `--allow-risky-actions` | Headless `run`/`exec`: auto-allow L3 actions; L4 remains denied | off |
| `--insecure` | Disable bearer token check (local dev only) | off |

Example:

```bash
kun serve \
  --config ~/.deepseekgui/kun/config.json \
  --host 127.0.0.1 \
  --port 8899 \
  --data-dir ~/.deepseekgui/kun \
  --runtime-token dev-token \
  --api-key "$DEEPSEEK_API_KEY" \
  --model deepseek-v4-pro
```

Kun can also run as a standalone agent without the GUI:

```bash
kun run --data-dir ~/.deepseekgui/kun --workspace "$PWD" "summarize this repo"
kun run --rigorous --data-dir ~/.deepseekgui/kun --workspace "$PWD" "make a careful change"
kun chat --data-dir ~/.deepseekgui/kun --workspace "$PWD"
kun exec --data-dir ~/.deepseekgui/kun --workspace "$PWD" --list-tools
kun exec --data-dir ~/.deepseekgui/kun --workspace "$PWD" read --args '{"path":"README.md"}'
```

- `kun run` creates a thread, runs one turn, streams assistant text, and exits.
- `kun run --rigorous` runs an opt-in four-stage pipeline: planner, executor, verifier, reviewer.
- `kun chat` starts a line-oriented REPL. Use `/exit`, `/quit`, or an empty line to stop.
- `kun exec --list-tools` prints the effective dynamic tool registry for the chosen config/workspace.
- `kun exec <tool> --args <json>` invokes one tool directly. Use `--json` on `run` or `exec` for machine-readable output; `run --json` includes final items and runtime events.
- Headless approvals are conservative: unknown L2 commands and L4 commands are denied instead of blocking forever. Use `--allow-risky-actions` only when a non-interactive run is expected to perform L3 work such as network access or installs.

## Rigorous Mode

Rigorous mode is opt-in per turn. API callers use `mode: "rigorous"` on
`StartTurnRequest`; CLI users pass `kun run --rigorous`. Normal turns do
not touch this pipeline.

The pipeline runs four child roles in sequence:

- `planner` is read-only and produces risks, steps, and verification criteria.
- `executor` implements the plan with workspace tools.
- `verifier` receives the user request, planner criteria, changed file list,
  and a captured `git diff`, but not the executor's narrative.
- `reviewer` receives the diff, plan, and verification report and emits
  `ship`, `fix`, or `replan`.

The reviewer can trigger one bounded fix round. After one fix attempt the
final verdict is surfaced to the parent turn as review items plus an assistant
summary. Child role approvals are bridged to the parent approval flow; L4
actions still require explicit approval and are never allow-listed.
Each `pipeline_stage_finished` event includes the resolved model and, when
available, the token usage for that specific role run.

Cost expectation: a rigorous turn is roughly four model runs, and six when a
fix round is used. Configure per-role routing under `roles`:

```json
{
  "roles": {
    "enabled": true,
    "planner": { "model": "deepseek-v4-pro" },
    "executor": { "model": "deepseek-v4-pro" },
    "verifier": { "model": "deepseek-v4-pro", "reasoningEffort": "high" },
    "reviewer": { "model": "deepseek-v4-pro", "reasoningEffort": "high" }
  }
}
```

Set `"roles": { "enabled": false }` to reject rigorous turn requests.

## Environment variables

The runtime reads these from `process.env` when not set via CLI flags.

- `KUN_CONFIG` – explicit JSON config file
- `KUN_HOST` – bind host (overrides `--host` if set)
- `KUN_PORT` – bind port (overrides `--port` if set)
- `KUN_DATA_DIR` – root data directory (overrides `--data-dir` if set)
- `KUN_RUNTIME_TOKEN` – bearer token (overrides `--runtime-token` if set)
- `KUN_BASE_URL` – model API base URL (overrides `--base-url` if set)
- `DEEPSEEK_BASE_URL` – fallback model API base URL
- `KUN_MODEL` – default model id (overrides `--model` if set)
- `DEEPSEEK_API_KEY` – the DeepSeek API key the adapter forwards
  to the upstream model. Required at runtime for the default
  model client.

## Config file

Kun supports a JSON config file so runtime behavior can be managed
without rebuilding or hard-coding loop thresholds.

Config resolution order is:

1. Built-in defaults.
2. JSON config file.
3. Environment variables.
4. CLI flags.

Use `--config <path>` or `KUN_CONFIG=<path>` for an explicit file. If
no explicit config is provided and `--data-dir` / `KUN_DATA_DIR` is set,
Kun also reads `{data-dir}/config.json` when it exists. In the GUI's
default setup this is:

```text
~/.deepseekgui/kun/config.json
```

Shape:

```json
{
  "serve": {
    "host": "127.0.0.1",
    "port": 8899,
    "dataDir": "~/.deepseekgui/kun",
    "runtimeToken": "",
    "apiKey": "",
    "baseUrl": "https://api.deepseek.com/beta",
    "model": "deepseek-v4-pro",
    "approvalPolicy": "auto",
    "sandboxMode": "workspace-write",
    "storage": {
      "backend": "hybrid",
      "deployment": "single-host"
    },
    "insecure": false
  },
  "contextCompaction": {
    "defaultSoftThreshold": 16000,
    "defaultHardThreshold": 24000,
    "summaryMode": "heuristic",
    "summaryTimeoutMs": 15000,
    "summaryMaxTokens": 1200,
    "summaryInputMaxBytes": 98304
  },
  "telemetry": {
    "enabled": true,
    "rotateBytes": 10485760,
    "keepFiles": 3
  },
  "contextEngine": {
    "enabled": true,
    "injectionTokenBudget": 2000,
    "playbook": { "enabled": true }
  },
  "evals": {
    "enabled": true
  },
  "memory": {
    "autoFormation": true
  },
  "actionLevels": {
    "enabled": true
  },
  "roles": {
    "enabled": true,
    "verifier": {
      "model": "deepseek-v4-pro",
      "reasoningEffort": "high"
    },
    "reviewer": {
      "model": "deepseek-v4-pro",
      "reasoningEffort": "high"
    }
  },
  "models": {
    "profiles": {
      "deepseek-v4-pro": {
        "contextWindowTokens": 1000000,
        "contextCompaction": {
          "softThreshold": 980000,
          "hardThreshold": 990000
        }
      },
      "deepseek-v4-flash": {
        "aliases": ["deepseek-chat", "deepseek-reasoner"],
        "contextWindowTokens": 1000000,
        "contextCompaction": {
          "softThreshold": 980000,
          "hardThreshold": 990000
        }
      }
    }
  },
  "capabilities": {
    "mcp": {
      "enabled": false,
      "servers": {
        "github": {
          "enabled": true,
          "transport": "stdio",
          "command": "npx",
          "args": ["-y", "@modelcontextprotocol/server-github"],
          "env": { "GITHUB_TOKEN": "<github-token>" },
          "trustScope": "workspace",
          "trustedWorkspaceRoots": ["/path/to/workspace"],
          "timeoutMs": 30000
        },
        "remote-docs": {
          "enabled": false,
          "transport": "streamable-http",
          "url": "https://mcp.example.com/mcp",
          "headers": { "authorization": "Bearer <docs-mcp-token>" },
          "trustScope": "user",
          "timeoutMs": 30000
        }
      }
    },
    "web": {
      "enabled": false,
      "fetchEnabled": false,
      "searchEnabled": false,
      "provider": "fetch",
      "allowDomains": [],
      "denyDomains": ["localhost", "127.0.0.1"]
    },
    "skills": {
      "enabled": false,
      "roots": ["~/.agents/skills", "./.agents/skills"],
      "legacySkillMd": true
    },
    "subagents": {
      "enabled": false,
      "maxParallel": 2,
      "maxChildRuns": 4
    },
    "attachments": {
      "enabled": false,
      "maxImageBytes": 5242880,
      "maxImageDimension": 4096,
      "allowedMimeTypes": ["image/png", "image/jpeg", "image/webp"],
      "textFallbackMaxBase64Bytes": 524288,
      "textFallbackMaxImageDimension": 1280,
      "textFallbackPreferredMimeType": "image/webp"
    },
    "memory": {
      "enabled": false,
      "scopes": ["user", "workspace", "project"],
      "maxInjectedRecords": 8,
      "retrievalBudgetBytes": 6144
    }
  }
}
```

Kun defaults to hybrid session storage: `threads/{threadId}/messages.jsonl`
and `events.jsonl` remain the canonical transcript/replay logs, while
`index.sqlite3` stores only rebuildable thread metadata for fast lists
and search. `serve.storage.deployment` defaults to `"single-host"`; setting
`"multi-host"` fails closed because the local file lease cannot provide
distributed fencing. Inject a distributed coordinator before enabling that
deployment. Set `serve.storage.backend` to `"file"` to use the legacy
JSON index backend, or set `serve.storage.sqlitePath` to override the
default `{dataDir}/index.sqlite3` path.

Model-specific context windows, capabilities, and compaction thresholds
belong in `models.profiles`. Built-in profiles already cover
`deepseek-v4-pro`, `deepseek-v4-flash`, and the compatibility aliases
`deepseek-chat` / `deepseek-reasoner`; DeepSeek V4 defaults to a 1M
context window and starts compaction around 980k input tokens.
The legacy `contextCompaction.modelProfiles` location is still read for
backward compatibility, but new configs should use `models.profiles`.
See `../docs/KUN_CONFIG.md` for the detailed file layout and examples.

Feature flags are intentionally explicit:

- `capabilities.mcp` starts configured MCP clients and imports their tools into the dynamic registry. Workspace-scoped servers require `trustedWorkspaceRoots`.
- `serve.mcpSearch` can collapse a large MCP catalog into four entry points: `mcp_search`, `mcp_describe`, `mcp_call`, and `mcp_refresh_catalog`. When the catalog is too large, the model searches for relevant tools first, then describes and calls the exact tool instead of carrying every MCP schema on every turn. `mcp_call` requires the fingerprint returned by `mcp_describe`; the provider revalidates it before sending.
- MCP calls validate declared input/output schemas and emit a redacted, structured outcome (`planned`, `approved`, `sent`, `acknowledged`, `failed_known`, `failed_unknown`, or `cancelled`) into telemetry. A timeout or cancellation after `sent` is deliberately `failed_unknown`; the host does not resend because the SDK cannot prove pre-send delivery.
- `serve.tokenEconomy` / `tokenEconomyMode` compresses tool descriptions, tool results, and history context while preserving code, paths, commands, URLs, errors, and other high-value signals.
- `contextCompaction` controls fallback long-thread compaction thresholds and summary behavior. Per-model thresholds live in `models.profiles`. Compaction preserves goals, constraints, decisions, touched files, tool outcomes, and unresolved next steps.
- `serve.runtimeTuning.toolStorm` suppresses repeated identical tool calls within a turn so useless tool loops do not keep spending tokens.
- `capabilities.web` exposes `web_fetch` and/or `web_search`. The built-in provider can fetch HTTP(S) pages; search requires a provider implementation and may report unavailable.
- `capabilities.skills` scans configured roots for `skill.json` manifests and, when `legacySkillMd` is true, older `SKILL.md` directories.
- `capabilities.attachments` stores image bytes outside thread logs and allows turns to reference `attachmentIds`. Vision-capable models receive image parts; text-only models receive a bounded compressed base64 text fallback.
- `capabilities.memory` stores long-term records under the data dir, retrieves scoped matches before turns, and exposes `memory_create`, `memory_update`, and `memory_delete` tools. JSON records are canonical; `memory-index.sqlite3` is a versioned, rebuildable FTS5/BM25 projection with metadata filters, a configured record cap, a byte budget, and a retrieval trace in diagnostics.
- `capabilities.subagents` exposes `delegate_task` with `maxParallel` and `maxChildRuns` concurrency budgets.

Thread mutations are fenced across the full read-modify-write operation. File
and hybrid stores infer a durable `FileTurnLeaseStore` for runtimes sharing a
data directory; tombstones reject stale upserts, revoke active turn leases,
and make late items/events fail closed. That lease uses the local host/PID
namespace only. Declaring a file store as `deployment: "multi-host"` throws at
composition time; multi-host deployments must inject a real distributed
`ThreadMutationCoordinator`/lease service rather than silently accepting an
unsafe local lock.

Use `GET /v1/runtime/info` for the runtime capability manifest and
`GET /v1/runtime/tools` for redacted provider diagnostics. The GUI
Settings page reads both routes.

## Data directory layout

`--data-dir` is the on-disk root for everything the runtime owns:

```
{--data-dir}/
  config.json      # Optional Kun runtime config
  attachments/     # Image metadata + content blobs when enabled
  memory/          # Long-term memory JSON records, tombstones, and memory-index.sqlite3
  child-runs/      # Delegated child run records when subagents are enabled
  ledger/          # Per-workspace context-engine ledger ({workspaceHash}.json)
  telemetry/       # Per-workspace tool/turn telemetry (JSONL, size-rotated)
  allowlist/       # Per-workspace remembered L2/L3 command patterns
  evals/           # Per-workspace eval suites ({workspaceHash}.json)
  threads/
    index.json
    {threadId}/
      thread.json     # ThreadRecord
      messages.jsonl  # TurnItem append-only
      events.jsonl    # RuntimeEvent append-only
      session.json    # Latest AgentSession projection
      usage.json      # Per-thread usage snapshot
```

Atomic JSON writes are used for `index.json`, `thread.json`, and
`session.json`. JSONL streams are append-only and tolerate malformed
lines (the next replay skips them). The renderer can re-read a
thread by listing `index.json` and replaying the per-thread JSONL.

`ledger/` and `telemetry/` are owned by the context engine
(`contextEngine` / `telemetry` config sections). The ledger is a
projection of runtime events (hot files, recent command errors, git
state, decisions extracted during compaction) injected each turn as a
budgeted `<workspace-state>` block; telemetry records every tool
execution and per-turn outcome. Both directories are always safe to
delete: the ledger degrades to empty and rebuilds from new sessions,
and telemetry is expendable. Set `telemetry.enabled: false` to stop
JSONL telemetry writes. Set `contextEngine.enabled: false` to skip
`<workspace-state>` injection while continuing to project the ledger,
which supports A/B measurement with the same runtime observations.

When `contextEngine.playbook.enabled` is true (default), the
`<workspace-state>` block also carries a workspace playbook computed
from telemetry: commands run at least twice with their success rate and
typical duration, hot search roots, and warnings for repeatedly failing
commands. The playbook is recomputed lazily when the telemetry file
grows and degrades to empty on unreadable telemetry.

`evals/` holds per-workspace eval suites (capped at 20 checks of
command + expectation: `exit-zero` or `contains`). The model evolves
the suite through the `eval_suite_update` tool; the rigorous verifier
stage runs the suite mechanically (results and a before/after suite
hash land in the verification report, so weakening checks mid-turn is
visible to the reviewer); and `kun eval --workspace <path>` runs it
standalone (`--json` for machine output, non-zero exit on any failing
check). Deleting `evals/` is safe: suites are advisory state.

The loop also emits an additive `agent_state` runtime event per model
step (estimated prompt tokens vs the compaction threshold, injected
workspace-state sections, and injected memory ids split into verified
facts vs unverified hypotheses). The GUI's Agent State panel renders
this live alongside rigorous pipeline stage progress.

Memory records may include a kind (`fact`, `procedure`, `gotcha`,
`episode`, `working`, or `hypothesis`), an explicit status, provenance,
relations, and freshness metadata. New records—including compaction
extracts—always start as `candidate`; a model inference cannot make a
record verified. The only promotion path is an official passing outcome
with durable evidence references, digests, and compatible workspace/project
identity. `ttl.expiresAt` excludes old records from retrieval, and
`ttl.staleWhen` can mark a record stale when its evidence file changes or
when git observes a different branch. Stale records stay on disk with
`staleAt` for review, but they are not injected. Evidence-less
model-inferred records are capped at confidence `0.5` and render as
unverified hypotheses. Use `rebuildIndex()` or delete the SQLite file to
recreate the derived index from canonical JSON.

When `memory.autoFormation` is true, structured compaction extracts can
form workspace memories: decisions become low-confidence hypothesis
candidates and resolved-error entries become gotcha candidates. Formation
is capped per compaction and deduplicated by normalized content. Harness
trial outcomes additionally form procedure candidates on passes and gotcha
candidates on failures; only a passing official outcome with independent
evidence promotes the procedure.

Action levels classify each tool call before execution: L0 read, L1
workspace edit, L2 local execution, L3 network/install/delegation, and
L4 destructive/credentials/publish. `actionLevels.enabled: false`
restores the pre-change level-gating behavior. L2/L3 command approvals
can be remembered per workspace in `allowlist/`; L4 actions are never
allow-listable. The default sandbox mode is now `workspace-write`
(breaking for CLI users who relied on the old implicit
`danger-full-access`; set it explicitly to keep that behavior).

## HTTP API

The HTTP server exposes the following routes under `/v1/*`:

| Method | Path | Description |
| --- | --- | --- |
| GET | `/health` | unauthenticated health probe |
| GET | `/v1/runtime/info` | runtime metadata and capability manifest |
| GET | `/v1/runtime/tools` | redacted dynamic tool/provider diagnostics |
| GET | `/v1/workspace/status?path=...` | workspace git/branch status |
| GET | `/v1/threads?include=side` | list threads (most recently updated first); side threads are hidden unless `include=side` is passed |
| POST | `/v1/threads` | create a thread |
| GET | `/v1/threads/{id}` | read a thread with its turns |
| PATCH | `/v1/threads/{id}` | update title/status/approval/sandbox/relation (promote a side thread by setting `relation: "primary"`) |
| DELETE | `/v1/threads/{id}` | delete a thread |
| POST | `/v1/threads/{id}/fork` | fork the thread. Optional JSON body: `{ "relation": "fork" \| "side", "title"?: string }` (defaults to `fork` when omitted). `relation: "side"` marks the result as a side conversation and tags `parentThreadId`. |
| POST | `/v1/threads/{id}/turns` | start a turn |
| GET | `/v1/threads/{id}/turns/{turnId}` | read a single turn |
| POST | `/v1/threads/{id}/turns/{turnId}/steer` | queue steering text |
| POST | `/v1/threads/{id}/turns/{turnId}/interrupt` | abort a turn |
| POST | `/v1/threads/{id}/compact` | fold old history |
| GET | `/v1/threads/{id}/events?since_seq=N` | SSE backlog + live |
| POST | `/v1/approvals/{approvalId}` | allow/deny |
| POST | `/v1/attachments` | upload an image attachment as base64 |
| GET | `/v1/attachments/diagnostics` | attachment store status |
| GET | `/v1/attachments/{id}` | attachment metadata |
| GET | `/v1/attachments/{id}/content?thread_id=...&workspace=...` | authorized attachment bytes as base64 |
| GET | `/v1/memory?workspace=...&include_deleted=false` | list memory records in scope |
| POST | `/v1/memory` | create a memory record |
| GET | `/v1/memory/diagnostics` | memory store status |
| PATCH | `/v1/memory/{id}` | update, disable, or retag a memory record |
| DELETE | `/v1/memory/{id}` | tombstone a memory record |
| GET | `/v1/usage` | cumulative token/cache/turn counters |

SSE events use `id: <seq>`, `event: <kind>`, and JSON `data:`. A
late-joining client passes `since_seq` to receive the backlog before
live events flow.

`POST /v1/threads/{id}/turns` accepts `attachmentIds` alongside
`prompt`, `model`, `mode`, and `guiPlan`. Attachments are resolved
against the turn thread/workspace and are never embedded into
thread JSONL logs. Runtime events may include optional child-agent
metadata, web citations/sources, attachment ids, active Skill ids,
and injected memory ids; older clients can ignore these fields.

## Thread record

Each thread persisted under `{data-dir}/threads/{id}/thread.json` is a
`ThreadRecord` with the following relation metadata:

- `relation`: discriminator describing how the thread relates to its
  origin. One of `primary` (default), `fork` (a manual fork that
  switches you away), or `side` (a "by-the-way" side conversation
  inherited from a parent snapshot).
- `parentThreadId`: live parent link for `fork` and `side` threads;
  absent for primary threads. Cleared automatically when promoting a
  side thread back to `primary` via `PATCH /v1/threads/{id}`.
- `forkedFromThreadId` / `forkedFromTitle` / `forkedAt` /
  `forkedFromMessageCount` / `forkedFromTurnCount`: lineage metadata
  copied from the parent for forks and side conversations.

The default `GET /v1/threads` listing excludes `relation: "side"`
threads to keep the main thread list uncluttered. Pass
`?include=side` to opt in.

## Migration notes

Legacy Skill folders that only contain `SKILL.md` continue to work
when `capabilities.skills.legacySkillMd` is true. New Skills should
prefer a `skill.json` manifest with explicit `id`, `description`,
trigger metadata, instruction file, and allowed tool list; this makes
activation and diagnostics deterministic. A safe migration path is:

1. Keep the existing `SKILL.md`.
2. Add a `skill.json` next to it that points at the same instructions.
3. Restart Kun or refresh diagnostics.
4. Once `/v1/runtime/tools` reports the Skill without validation
   errors, decide whether to keep legacy compatibility enabled.

Existing thread-level `pinnedConstraints` are not converted into
long-term memory automatically. They remain part of compaction items
and replay exactly as before. If a constraint should become
cross-thread recall, create an explicit memory record through the
GUI memory review surface or the `memory_create` tool. If it should
stay local to one thread, leave it as a pinned constraint.

## Troubleshooting

- MCP server does not appear: check `capabilities.mcp.enabled`, the
  server `enabled` flag, transport-specific fields (`command` for
  `stdio`, `url` for HTTP/SSE), `trustedWorkspaceRoots` for
  workspace-scoped servers, and `/v1/runtime/tools` for redacted
  `lastError` diagnostics.
- Web tools are missing: `capabilities.web.enabled` must be true and
  at least one of `fetchEnabled` / `searchEnabled` must be true.
  Built-in fetch handles HTTP(S) pages; search may still be
  unavailable when no provider implementation is configured.
- Image upload succeeds but the turn fails: check `maxImageBytes`,
  `maxImageDimension`, `allowedMimeTypes`, and the text fallback limits.
  Text-only models need a compressed fallback small enough to fit
  `textFallbackMaxBase64Bytes`.
- Memory is not injected: enable `capabilities.memory`, confirm
  `/v1/memory/diagnostics.enabled`, make sure records are in the
  selected workspace scope and not disabled/deleted, then inspect
  `lastInjectedIds`.
- `kun run`, `kun chat`, or `kun exec` cannot authenticate or load
  config: pass the same `--config`, `--data-dir`, `--api-key`,
  `--base-url`, and `--runtime-token` values used by `kun serve`.
  `kun exec --list-tools --json` is the quickest way to verify the
  effective tool registry for a CLI environment.
- A capability reports `disabled`: that normally means the config flag
  is false. A capability reports `unavailable`: the flag is true, but
  the backing provider/store/model is absent or failed initialization.

## GUI integration

After the legacy provider retirement, the DeepSeek-GUI main process
starts Kun through `kun-process.ts` and routes all
`runtimeRequest` calls to the active base URL with a bearer token.
The renderer uses the same `AgentProvider` interface as the legacy
CodeWhale provider because Kun speaks the same HTTP/SSE
contract. Settings live under `agents.kun` in
`AppSettingsV1` and include `binaryPath`, `port`, `autoStart`,
`apiKey`, `baseUrl`, `runtimeToken`, `dataDir`, `model`,
`approvalPolicy`, `sandboxMode`, and `insecure`.

The renderer also consumes the extension routes added for the larger
agent surface: `/v1/runtime/info`, `/v1/runtime/tools`,
`/v1/attachments/*`, and `/v1/memory/*`. Composer image controls are
enabled only when both the runtime attachment capability and model
image modality are available. Settings diagnostics display MCP
servers, Skill roots, web provider state, attachment store state,
memory records, and the live capability manifest.

Legacy persisted settings (`agentProvider: "codewhale"` or
`"reasonix"`) are migrated by `migrateLegacyAppSettings`.
Legacy credentials, base URLs, ports, and model selections seed
`agents.kun`; the saved settings file no longer keeps live
CodeWhale or Reasonix agent entries.
