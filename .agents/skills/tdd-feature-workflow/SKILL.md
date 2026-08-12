---
name: tdd-feature-workflow
description: "Use from the main session whenever implementing a new feature, capability, user-visible behavior, API behavior, integration, regression fix, or hotfix in this repository, even if the user does not mention tests or TDD. Orchestrates resumable test-engineer and feature-engineer workers through mechanical RED, GREEN, and full-quality gates. Do not invoke this skill inside a subagent."
---

# TDD feature workflow

Run this workflow only in the primary orchestration context. Do not preload this skill into either worker. Keep orchestration in the coordinator while each worker receives only its role definition and delegated task.

Use the workflow for new behavior and behavior-changing fixes, including hotfixes that correct a regression. Do not use it for read-only investigation, explanations, documentation-only edits, formatting-only changes, or refactors that intentionally preserve behavior.

Resolve the bundled `scripts/tdd-gate.ts` file from this skill's installation directory. In the commands below, `<gate>` means:

`bun <skill-directory>/scripts/tdd-gate.ts`

## Coordinator responsibilities

The coordinator is the hub. It owns phase transitions, worker invocation, worker-ID continuity, specialist routing, quality verification, and the final report. Workers do not ping-pong directly.

The gate persists the first `test-engineer` and `feature-engineer` worker IDs in its local workflow state. When a phase must be revisited, use the harness's existing-worker continuation or messaging mechanism with the recorded ID so the worker resumes its prior context. Do not spawn a replacement merely because a later gate fails. If the harness cannot resume workers, report that limitation instead of silently discarding context.

Workflow state is scoped to the coordinator session and its workers. Concurrent coordinator sessions in the same checkout must not share phases, blockers, or worker IDs. The lifecycle adapter supplies this session identity automatically; do not invent or reuse it.

## Phase 0: establish or resume state

First inspect the state:

`<gate> status`

- If an incomplete workflow exists for this request, resume it from its recorded phase and worker IDs.
- If no workflow exists, start one before any production edit:

  `<gate> start --task "concise feature summary"`

- If an incomplete workflow belongs to a different request, do not overwrite it. Ask whether to resume or explicitly abort it.

The start command snapshots all pre-existing dirty files by content hash. The RED gate therefore distinguishes this feature's edits from unrelated user changes already in the worktree.

## Phase 1: tests and RED

Invoke exactly one `test-engineer` worker with:

- the requested outcome and acceptance criteria
- relevant scope discovered by the coordinator
- explicit instruction to own tests only and run the mechanical RED command

The configured worker-start hook records its ID. The test-engineer cannot edit production files, and the worker-stop gate refuses completion until RED is verified.

After it returns, run `status` and confirm:

- phase is `red_verified`
- `agents.test-engineer` is present
- the expected marker identifies a behavioral failure
- no production file changed after the baseline

Do not proceed on a syntax, import, fixture, test-discovery, environment, or unrelated failure.

## Phase 2: implementation and GREEN

Invoke exactly one `feature-engineer` worker with:

- the original outcome and acceptance criteria
- the RED test paths, command, expected failure, and evidence from state
- explicit instruction to own production code only and run the mechanical GREEN command

The feature-engineer cannot edit test files. The GREEN gate hashes the RED tests and refuses success if they changed. The worker-stop gate refuses completion until the unchanged RED tests pass.

After it returns, run `status` and confirm phase is `green_verified` and `agents.feature-engineer` is present.

## Phase 3: hard quality gate

The coordinator runs:

`<gate> verify`

This deterministic command runs, in order:

1. `bun run format`
2. the focused GREEN command again after formatting
3. `bun run lint`
4. `bun run typecheck`
5. `bun test`
6. `bun run build`

The configured completion gate prevents the coordinator from declaring completion while the state is incomplete.

## Failure routing and context preservation

- A test design, fixture, coverage, or missing-acceptance-criterion problem belongs to the recorded test-engineer. Resume it through the harness's continuation mechanism; any test edit invalidates prior RED and requires a new RED proof.
- A production behavior, type, lint, build, or focused GREEN problem belongs to the recorded feature-engineer. Resume it through the harness's continuation mechanism and re-run GREEN.
- A database or dependency need belongs to the applicable specialized project worker, coordinated by the coordinator without replacing the two TDD owners.
- An ambiguous requirement or unavailable prerequisite is reported by a worker with `TDD_BLOCKED:`. The worker-stop gate stores the blocker and lets the coordinator yield to the user without discarding state or worker IDs.

Use the worker IDs printed by `status`. A supported resume operation must preserve the worker's prior context; creating a new worker does not.

After the blocker is resolved, clear the blocker with:

`<gate> resume`

Then resume the recorded worker through the harness's continuation or messaging mechanism with the new decision or prerequisite.

## Cancellation

Abort only when the user cancels the feature or the scope is intentionally abandoned:

`<gate> abort --reason "explicit reason"`

Do not use abort to bypass a failing gate.

## Final handoff

Report:

- RED test paths, command, expected failure, and why it was valid
- production implementation that produced GREEN
- whether either worker was resumed and why
- results of format, focused GREEN, lint, typecheck, full tests, and build
- any manual verification or residual risk
