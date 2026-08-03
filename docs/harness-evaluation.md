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
  --replicates 5 \
  --order-seed 17 \
  --max-cost-usd 5 \
  --change-manifest path/to/change-manifest.json
```

Defaults are `deepseek-v4-flash`, `chat_completions`, USD 5 aggregate declared
cost, and the small deterministic fixture subset. `--subset smoke` produces a
single local task; the default `small` subset produces two. The runner divides
the ceiling across baseline and adaptive conditions, rejects manifest budgets
whose aggregate exceeds the ceiling, and exits nonzero for an infrastructure
failure, a failed trial, or an inconclusive result.

Generated fixture manifests carry an optional `attemptId` (`replicate-1`,
`replicate-2`, ...). `--replicates` creates matched baseline/adaptive pairs per
attempt and gives every attempt an isolated data directory. Pair groups are
shuffled deterministically by `--order-seed`, and the first condition alternates
across pair groups (with the seed choosing the starting side) while each pair
remains adjacent for clean reset and auditability. The comparison report
retains discordant-pair counts and a deterministic paired-bootstrap 95%
confidence interval; one run per task is descriptive, not a promotion result.

`--change-manifest` is evaluated only after the trials finish. The runner
compares its task/replicate counts, paired delta, bootstrap interval,
false-completion delta, regressions, and evidence digests against the immutable
report; a self-declared favorable JSON cannot promote a smoke run. Any mismatch
forces `inconclusive` and records the rejection reasons.

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

The runner process receives `DEEPSEEK_API_KEY` only through its environment.
For a live Linux trial, it passes the value through a one-shot inherited pipe,
the Kun CLI closes that descriptor before starting the agent, and the trial is
launched in a private PID/user namespace (`unshare --pid --user --mount-proc`).
This prevents model-controlled tools from walking back to the credential-owning
runner through `/proc`; their own subprocess environment is still an explicit
non-secret allowlist. If those namespaces are unavailable, the trial is
inconclusive rather than falling back to a host process. Raw stdout and stderr
from the preflight, Kun CLI, and official verifier are redacted and omitted
from both reports.

`kun harness run` uses a sealed option parser: it ignores `data-dir/config.json`
and `KUN_CONFIG`, rejects endpoint/model/approval/sandbox/config overrides, and
builds runtime options from the manifest plus fixed harness defaults. A trial
data directory therefore cannot redirect the provider credential to an
attacker-controlled endpoint.

Comparison consumes only controller receipts whose Ed25519 signature verifies
against an explicit public-key trust store. Shape and digest bindings alone are
not authority. For example:

```bash
node kun/dist/cli/serve-entry.js harness compare suite.json \
  --attestation-trust-store controller-keys.json
```

The trust-store JSON is either `{ "controller-key-id": "<public PEM>" }` or
`{ "keys": { "controller-key-id": "<public PEM>" } }`. Omitting it is a
fail-closed configuration error. `replay-harness-trial.mjs` intentionally
reconstructs only the local/internal outcome; it does not mint or verify an
official benchmark result.

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

The local runner does not treat `separate-process` as a trusted verifier: a
host process is not a filesystem or network boundary, so the agent could inspect
or mutate a sibling verifier. `container` and `remote` are accepted as adapter
metadata but remain `unsupported-isolation` here until a Harbor/Docker or
remote controller executes them through its real boundary and publishes the
result outside this runner. No model key or broader caller environment is
forwarded to any diagnostic host process.

The per-trial Kun data directory is likewise diagnostic storage, not a
confidentiality boundary for a host-shell model. Do not run untrusted benchmark
tasks in the local sidecar mode; use a controller-owned container/VM that mounts
only the workspace and hides runtime/session storage before seeking an official
result.

## Reports and fair comparisons

Reports are written to `.harness-evaluation/report.json` and
`.harness-evaluation/report.md` by default. They contain the task id, condition,
model/protocol, dataset/version, manifest hash, harness commit, Kun outcome,
external-verifier outcome, cost, latency, cache hit rate, and A/B regression or
recovery lists, including a p95 total-token delta. They contain no key, verifier
output, oracle output, or model chain-of-thought.
Manifest identity also includes a materialized workspace snapshot digest (Git
revision, tracked diff, and untracked/ignored file hashes), or a digest supplied
by a trusted external snapshot controller. A workspace path alone is not a
valid A/B identity. The local capture is bounded (512 untracked/ignored paths,
4,096 files, and 256 MiB); a larger or incomplete tree is recorded as
unavailable and makes the harness trial inconclusive. Run large or dependency-
heavy workspaces through a clean snapshot controller instead of weakening this
boundary or reusing a dirty checkout.

The deterministic local fixtures reset a clean Git workspace before each
condition and run `normal` as the AgentLoop baseline and `adaptive` as the
rigorous harness with identical model/protocol/budgets. A completed normal
baseline has no rigorous completion-gate artifact, so its internal
`TrialRecorder` outcome is expected to be `inconclusive`. The local runner
retains internal verdicts and sidecar metadata, but treats every host-side
sidecar as unsupported; only a controller-attested container/remote verdict
can become the final benchmark outcome. A generic unenforced `network` or
`custom` constraint remains inconclusive. These fixtures are only wiring smoke
coverage; despite carrying a Terminal-Bench 2.1 compatibility identity, they
are not downloaded Terminal-Bench results and cannot support a broad benchmark
claim. Supplied manifests are independent trials unless an external controller
resets the workspace between conditions and attempts.

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

## Local control contracts

The local implementation now contains the following bounded controls. They are
contracts and fail-closed checks; they are not evidence that an external
benchmark has improved.

- `kun/src/harness/compare.ts` pairs by `taskId + attemptId` and reports the
  deterministic paired-bootstrap interval. Duplicate pairs, incompatible
  manifests, missing receipt trust, and invalid Ed25519 receipts are rejected.
- `kun/src/orchestration/rigorous-pipeline.ts` enforces allowed/forbidden paths
  against both the execution artifact and the captured Git diff. `network` and
  unregistered `custom` constraints are reported as inconclusive with their
  enforcement owner instead of being silently treated as satisfied.
- `kun/src/harness/trial-recorder.ts` emits a redacted, append-only causal trace
  with sequence, `causeId`, and `parentId`; `validateTrialCausalTrace` is the
  independent structural check used by tests. Raw verifier output remains
  outside the model-visible record. Current v3 envelopes call the local
  gate-derived field `internalOutcome`; `officialOutcome` is accepted only when
  reading historical v1/v2 envelopes. Only `externalAttestation.outcome` is
  used for official comparison/promotion.
- `kun/src/orchestration/recovery-artifact.ts` parses the adaptive critic's
  tagged `RecoveryArtifact` and accepts only trusted evidence IDs, a bounded
  operation, a mechanical verification signal, and a stop boundary. Malformed
  or repeated hypotheses stop recovery.
- `kun/src/context-engine/repository-retrieval.ts` is disabled by default. When
  enabled, it is revision-keyed, read-only, line-range bounded, and preserves
  exact source at the selected locus; retrieval metrics alone never promote a
  harness change.
- `kun/src/harness/change-manifest.ts` defines the offline
  discovery/validation/final corpus and requires a validated final result,
  positive confidence, no regressions/false completion/tampering, a ready
  rollback, and a signature-verified external Ed25519 promotion receipt before
  promotion.

The local poisoning regression corpus (`kun/tests/memory-poisoning.test.ts`)
exercises 120 compaction-derived injection candidates and 100 independently
verified memories: default retrieval returns none of the candidates and retains
all 100 verified records. This is a policy regression test, not evidence of
general attack resistance; the external acceptance gate remains 95% blocking and
95% legitimate retention on a controller-owned corpus.

The corresponding focused tests are `compare`, `completion-gate`,
`rigorous-pipeline`, `trial-recorder`, `recovery-artifact`,
`repository-retrieval`, and `change-manifest`. Run the full local gate before
any external claim:

```bash
npm --prefix kun run typecheck
npm --prefix kun test
npm --prefix kun run build
npm exec eslint -- kun/src kun/tests
git diff --check
```

The append-only trial trace can be checked outside the Kun runtime after a
build. This reconstructs the sealed outcome from the JSONL envelope and causal
records; it does not contact the model or workspace:

```bash
node scripts/replay-harness-trial.mjs path/to/trial.jsonl
```
