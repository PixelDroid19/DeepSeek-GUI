# Harness checkpoint — 2026-08-03 local baseline

This checkpoint records the strongest evidence available in the clean checkout
without claiming a provider or benchmark result.

## Scope

- Repository: `/home/monasterios/Documents/IA/DeepSeek-GUI`
- Current commit: `18298f2` (`master`, pushed to `origin/master`)
- Local working tree: clean after incremental harness commits.
- External state: no `DEEPSEEK_API_KEY`, Harbor/Docker controller, signed verifier
  receipt, or downloaded Terminal-Bench corpus was available.

## Reproducible local gate

Run from the repository root:

```bash
npm --prefix kun run typecheck
npm --prefix kun test
npm --prefix kun run build
npm exec eslint -- kun/src kun/tests
node --check scripts/run-flash-harness-eval.mjs
node --check scripts/replay-harness-trial.mjs
git diff --check
```

The gate is a prerequisite, not benchmark evidence. A missing credential must
remain an infrastructure stop:

```bash
env -u DEEPSEEK_API_KEY node scripts/run-flash-harness-eval.mjs --subset smoke
```

Expected result: exit `2` before provider/network work begins.

Latest local run (after receipt, historical JSONL, seed propagation, symlink,
retrieval, and poisoning changes): 84 test files / 791 tests passed; Kun
typecheck, root typecheck, root lint, Kun + Electron/Vite build, both script
syntax checks, and `git diff --check` also passed. `replay-harness-trial.mjs
--help` exits 0; no-key runner preflight exits 2; `harness compare` without
`--attestation-trust-store` exits 78 by design.

## Checkpoint artifacts and rollback

- Trial JSONL must be replayable with
  `node scripts/replay-harness-trial.mjs <trial.jsonl>`.
- ChangeManifest promotion requires a sealed external final corpus, a verified
  rollback restore, and controller attestation; local fixtures are rejected.
- The local work is uploaded in incremental commits `0477e7f`, `2090ada`,
  `bb68f04`, and `18298f2`. The worktree is clean; do not reset, stash, or
  discard unrelated user changes if new work is added later.
- Before any external run, materialize a fresh controller-owned workspace and
  record pre/post snapshot digests, verifier receipt digests, model revision,
  task seed, and attempt id. If any binding is absent, mark the run
  inconclusive.
- The local poisoning regression covers 120 compaction candidates and 100
  independently promoted memories; it is a local policy test, not an external
  attack-rate claim.

## Stop condition

Do not report improvement until an externally attested paired A/B sample meets
the thresholds in the active goal. Until then this checkpoint is local
engineering evidence only.
