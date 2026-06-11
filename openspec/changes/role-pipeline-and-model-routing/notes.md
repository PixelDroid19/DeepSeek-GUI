# Change Notes — Role Pipeline and Model Routing

## Manual smoke 6.3

Status: pending.

Credential readiness checked on 2026-06-11:

- `DEEPSEEK_API_KEY`: missing
- `KUN_API_KEY`: missing
- `/Users/admin/.deepseekgui/kun/config.json`: present, but no `apiKey`
- Other checked config candidates (`~/.kun/config.json`, `~/.config/kun/config.json`, repo `kun.config.json`, repo `config.json`): missing

Do not mark task 6.3 complete until a real model-backed normal turn and a real model-backed rigorous turn have both run and the table below is filled.

Recommended prompt for both runs:

```text
Create .kun-smoke/phase3-smoke.txt with exactly this single line: phase3 rigorous smoke ok
```

Recommended commands, using temporary workspace copies so the current working tree is not damaged:

```bash
npm --prefix kun run build

SMOKE_ROOT="$(mktemp -d /tmp/kun-phase3-smoke.XXXXXX)"
SMOKE_API_KEY="${KUN_API_KEY:-${DEEPSEEK_API_KEY:-}}"
rsync -a --exclude node_modules --exclude dist "$PWD/" "$SMOKE_ROOT/normal-workspace/"
rsync -a --exclude node_modules --exclude dist "$PWD/" "$SMOKE_ROOT/rigorous-workspace/"

/usr/bin/time -p env KUN_API_KEY="$SMOKE_API_KEY" \
  node kun/dist/cli/serve-entry.js run \
  --json \
  --data-dir "$SMOKE_ROOT/normal-data" \
  --workspace "$SMOKE_ROOT/normal-workspace" \
  "Create .kun-smoke/phase3-smoke.txt with exactly this single line: phase3 rigorous smoke ok" \
  > "$SMOKE_ROOT/normal.json" 2> "$SMOKE_ROOT/normal.time"

/usr/bin/time -p env KUN_API_KEY="$SMOKE_API_KEY" \
  node kun/dist/cli/serve-entry.js run \
  --json \
  --rigorous \
  --data-dir "$SMOKE_ROOT/rigorous-data" \
  --workspace "$SMOKE_ROOT/rigorous-workspace" \
  "Create .kun-smoke/phase3-smoke.txt with exactly this single line: phase3 rigorous smoke ok" \
  > "$SMOKE_ROOT/rigorous.json" 2> "$SMOKE_ROOT/rigorous.time"
```

The rigorous run's `pipeline_stage_finished` events include per-role `usage` when the provider reports usage. Record the stage values here:

Extract status, wall time, and per-stage usage from the two JSON/time files:

```bash
node <<'NODE' "$SMOKE_ROOT/normal.json" "$SMOKE_ROOT/normal.time" "$SMOKE_ROOT/rigorous.json" "$SMOKE_ROOT/rigorous.time"
const fs = require('fs')
const [normalJson, normalTime, rigorousJson, rigorousTime] = process.argv.slice(2)
function readRun(jsonPath, timePath) {
  const run = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
  const real = fs.readFileSync(timePath, 'utf8').match(/^real\s+(.+)$/m)?.[1] ?? ''
  const stageUsage = Object.fromEntries(
    (run.events ?? [])
      .filter((event) => event.kind === 'pipeline_stage_finished')
      .map((event) => [event.role, event.usage?.totalTokens ?? 'n/a'])
  )
  return { status: run.status, real, stageUsage }
}
console.log(JSON.stringify({
  normal: readRun(normalJson, normalTime),
  rigorous: readRun(rigorousJson, rigorousTime)
}, null, 2))
NODE
```

| Run | Status | Wall time real | Planner tokens | Executor tokens | Verifier tokens | Reviewer tokens | Total tokens | Notes |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| normal | pending |  | n/a | n/a | n/a | n/a |  |  |
| rigorous | pending |  |  |  |  |  |  |  |

Acceptance for 6.3:

- Both runs complete with status `completed`.
- Both workspace copies contain `.kun-smoke/phase3-smoke.txt` with the exact requested line.
- Rigorous events include planner, executor, verifier, reviewer started/finished in order.
- Rigorous finished-stage events include per-stage usage, or the notes explicitly state that the provider did not emit usage.
- The normal-vs-rigorous wall time and token comparison is recorded in the table above.
