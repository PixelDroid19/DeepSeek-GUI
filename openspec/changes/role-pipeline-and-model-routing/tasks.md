# Tasks — Role Pipeline and Model Routing (Phase 3)

## 1. Contracts and config

- [ ] 1.1 Add `kun/src/contracts/roles.ts`: role ids, stage artifact schemas (plan, execution, verification, verdict), `parseStageArtifact()` lenient fenced-JSON parser (generalizing the Phase 1 compaction-extraction pattern) with unit tests for valid/malformed/missing blocks per artifact type
- [ ] 1.2 Add `roles` config section to `kun-config.ts` (`enabled=true`, per-role `model`/`reasoningEffort` with schema validation) plumbed through `cli-options.ts`/`serve.ts`/`runtime-factory.ts` (tests incl. invalid effort rejection)
- [ ] 1.3 Add additive runtime event kinds `pipeline_stage_started`/`pipeline_stage_finished { role, status, model, artifactSummary? }` to `contracts/events.ts` and the event reducer; extend the `review` turn item with an optional `role` field for verifier/reviewer artifacts
- [ ] 1.4 Extend turn request contract with `mode: 'rigorous'`; validation rejects it on plan-mode threads and when `roles.enabled` is false (tests)

## 2. Role profiles and routing

- [ ] 2.1 Implement `kun/src/orchestration/role-profiles.ts`: built-in profiles (planner/reviewer read-only + read tools; executor full; verifier read+bash) with prompt addenda encoding each role's incentive (planner enumerates risks/criteria; verifier rewarded for breaking, receives criteria not narrative; reviewer outputs verdict)
- [ ] 2.2 Implement `resolveRoleModel(role, rolesConfig, threadModel)` with precedence config > built-in default > thread model (unit tests for each precedence layer)

## 3. Child executor extensions

- [ ] 3.1 Extend `createChildAgentExecutor` options with per-run `allowedToolNames`, `sandboxMode` override, and `systemPromptAddendum` (threaded into the child's tool context and prefix); existing delegation callers unchanged (regression test)
- [ ] 3.2 Add optional `approvalBridge: (approval) => Promise<ApprovalResolution>` forwarding child approvals to the parent gate; absent bridge preserves auto-allow; parent abort signal propagates to pending child approvals (deadlock test)
- [ ] 3.3 Return structured output from child runs: raw final text + parsed stage artifact + per-run usage

## 4. Rigorous pipeline

- [ ] 4.1 Implement `kun/src/orchestration/rigorous-pipeline.ts`: sequential planner → executor → verifier → reviewer with artifact handoff; pipeline captures `git diff` itself between executor and verifier stages
- [ ] 4.2 Enforce information hygiene: verifier prompt = user request + plan (risks/criteria) + captured diff + filesChanged, explicitly excluding executor summary (unit test asserting absence); reviewer prompt = diff + plan + verification report
- [ ] 4.3 Implement degradation rules: planner parse failure → fall back to normal loop with warning event; executor/verifier prose pass-through; reviewer failure → verdict `fix` (tests per rule)
- [ ] 4.4 Implement the bounded fix round (executor re-run with findings → verifier → final verdict; never a third round) with tests for fix→ship and fix→fix paths
- [ ] 4.5 Emit stage events, persist verification report and verdict as parent-thread `review` items with `role`, and roll up per-stage usage into the parent thread (resolve the UsageService labeled-merge open question)
- [ ] 4.6 Dispatch in `turn-service.ts`/`runtime-factory.ts`: rigorous requests route to the pipeline; pipeline failure marks the turn failed with stage context in the error

## 5. Entry points

- [ ] 5.1 Add `--rigorous` flag to `kun run` (composes with `--allow-risky-actions`); document in README
- [ ] 5.2 Accept optional `planArtifact` input to skip the planner stage when a GUI plan exists (resolve design open question; test that provided plans flow to executor and verifier)

## 6. Verification and rollout

- [ ] 6.1 End-to-end pipeline test with fake models scripted per stage: full happy path (8 events, verdict ship, items persisted) and approval-bridge path (verifier L2 command surfaces approval)
- [ ] 6.2 Run full kun suite + lint; fix fallout
- [ ] 6.3 Manual smoke: real rigorous session on this repo with a small change; record per-stage token usage and wall time in the change notes; compare against a normal turn for the same task
- [ ] 6.4 Document rigorous mode, role config, and cost expectations in the kun README
