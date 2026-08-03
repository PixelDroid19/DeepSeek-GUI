# Harness evaluation

## Status

No live DeepSeek Flash trial has been run from this checkout. No
`DEEPSEEK_API_KEY` was supplied for this change, so there are no task-level
pass/fail results, costs, latency measurements, cache rates, regressions, or
benchmark-improvement claims to report.

The bounded runner is [`scripts/run-flash-harness-eval.mjs`](../scripts/run-flash-harness-eval.mjs). It uses the existing
`kun harness run` CLI subprocess, whose result is produced by the existing
`TrialRecorder`; it does not start another runtime or model provider.

## Preconditions and invocation

The runner accepts either strict, already-versioned manifest paths or a
deterministic local smoke fixture. It never fetches datasets or installs an
unknown benchmark. The only credential input is the `DEEPSEEK_API_KEY`
environment variable; the variable name, not its value, is recorded.

```bash
node scripts/run-flash-harness-eval.mjs --help

DEEPSEEK_API_KEY=... node scripts/run-flash-harness-eval.mjs \
  --manifest path/to/baseline.json \
  --manifest path/to/harness.json \
  --max-cost-usd 5
```

Defaults are `deepseek-v4-flash`, `chat_completions`, USD 5 aggregate declared
cost, and the small deterministic fixture subset. `--subset smoke` produces a
single local task; the default `small` subset produces two. The runner divides
the ceiling across baseline and adaptive conditions, rejects manifest budgets
whose aggregate exceeds the ceiling, and exits nonzero for an infrastructure
failure, a failed trial, or an inconclusive result.

Before it creates a model or verifier subprocess, it runs exactly these local
checks and stops on the first failure:

```bash
npm --prefix kun run typecheck
npm --prefix kun test
npm --prefix kun run build
node scripts/check-license-boundary.mjs
```

The model trial is then invoked only as:

```bash
node kun/dist/cli/serve-entry.js harness run <manifest> --harness-json --data-dir <trial-data-dir>
```

The process receives `DEEPSEEK_API_KEY` only through its environment. Raw
stdout and stderr from the preflight, Kun CLI, and official verifier are
redacted and omitted from both reports.

## Benchmark adapter boundary

`adaptHarborTask` and `adaptTerminalBenchTask` accept only public task metadata:
an id, instruction, workspace root, verifier command, dataset/version,
environment digest, and explicit verifier-isolation mode. They reject missing
versions or digests, unisolated verifiers, and credential/oracle/solution-shaped
fields. Terminal-Bench support is deliberately pinned to dataset
`terminal-bench` version `2.1`.

Each adapter returns a strict parsed manifest and a separate
`hiddenMechanicalCheck`. The check contains the verifier command and isolation
mode but is not added to `manifest.task.verification`, so neither the command,
private verifier output, nor a reference solution becomes model-visible task
data. A benchmark controller invokes that descriptor after the Kun trial.

For a local runner invocation, keep the descriptor in a sibling sidecar rather
than in the manifest:

```json
{
  "version": 1,
  "taskId": "example-task",
  "check": {
    "id": "official-verifier:example-task",
    "command": "<isolated verifier command>",
    "isolation": "separate-process",
    "timeoutMs": 300000
  }
}
```

The file must be named `<manifest>.verifier.json`. It is strict and rejects
credential/oracle/solution-shaped fields. If it is absent or the isolated
verifier cannot complete, a model-side `pass` is reported as **inconclusive**,
not as an official benchmark pass.

The local runner dispatches only `separate-process` sidecars. It accepts
`container` and `remote` as valid adapter metadata but records them as
`unsupported-isolation` and exits inconclusively without running their command
on the host. A Harbor/Docker or remote benchmark controller must run those
verifiers through its real isolation boundary and publish the resulting record
outside this runner. Host-dispatched verifiers receive only a minimal `PATH`,
temporary-directory, locale, and timezone environment; no model key or broader
caller environment is forwarded.

## Reports and fair comparisons

Reports are written to `.harness-evaluation/report.json` and
`.harness-evaluation/report.md` by default. They contain the task id, condition,
model/protocol, dataset/version, manifest hash, harness commit, Kun outcome,
external-verifier outcome, cost, latency, cache hit rate, and A/B regression or
recovery lists. They contain no key, verifier output, oracle output, or model
chain-of-thought.

The deterministic local fixtures reset a clean Git workspace before each
condition and run `normal` as the AgentLoop baseline and `adaptive` as the
rigorous harness with identical model/protocol/budgets. A completed normal
baseline has no rigorous completion-gate artifact, so its internal
`TrialRecorder` outcome is expected to be `inconclusive`; the runner uses its
isolated external verifier as the final baseline result. A harness condition
must satisfy both its completion gate and the external verifier. They are only
a wiring smoke test; despite carrying a Terminal-Bench 2.1 compatibility
identity, they are not a downloaded Terminal-Bench result and cannot support a
broad benchmark claim. Supplied manifests are reported as independent trials
unless their execution environment is reset by an external benchmark controller,
because the runner cannot assume that a Harbor/Docker workspace can be safely
reused for an A/B comparison.

## Current evaluation record

| Field | Current value |
| --- | --- |
| Task ids | None; no live trial was authorized by available credentials. |
| Model/protocol | `deepseek-v4-flash` / `chat_completions` (runner defaults). |
| Dataset/version | No external dataset was fetched or run. |
| Harness commit | Not recorded by a live trial. |
| Pass/fail | Not available. |
| Regressions/recoveries | Not available. |
| Cost/latency/cache hit rate | Not available. |
| Infrastructure exclusions | Live network trial intentionally not started without `DEEPSEEK_API_KEY`. |

The absence of this live result is intentional. A future report may describe a
small smoke or fixture subset, but it must state the exact task ids and must not
claim an aggregate Terminal-Bench improvement without a clean, version-pinned,
externally verified A/B sample.
