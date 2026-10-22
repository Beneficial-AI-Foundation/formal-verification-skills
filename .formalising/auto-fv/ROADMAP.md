# FVS auto track roadmap

This is the plan of record for the FVS 3.0 `auto` track on branch `feat/auto-track`. It records what the owner has decided, how the work is split between Agent Orchestrator (AO), FVS and small deterministic tools, and what has to be true before a milestone counts as done. Changes to decisions go through the owner and are noted in the status log.

## Purpose

FVS 3.0 adds an `auto` track of four commands, `/fvs:auto-init`, `/fvs:auto-extract`, `/fvs:auto-top-specs` and `/fvs:auto-execute`, that run a functional-correctness verification project end to end with Agent Orchestrator (AO) as the coordinator. AO already manages sessions, worktrees, lifecycle and reviews, so the track uses it as it is: the outcome is a reviewed FVS 3.0 release, and building a new orchestrator or forking AO is out of scope. The track should be usable by someone new to functional-correctness verification, while every proof claim it makes stays precise and is checked independently of the agent that produced it.

## Decisions (owner-confirmed 2026-10-21)

Each decision is followed by its reason. Items marked 2026-10-22 were added or changed after the kickoff review and the owner's process decision of that day.

- `feat/auto-track` is based on `release/2.3.8`. That branch contains the autonomous lean-verify loop with its wall-clock budget and cheat audit (#90), and auto-execute reuses that loop. The branch will be rebased onto main after 2.3.8 ships.
- Process (updated 2026-10-22). Decisions are taken through grilling rounds with the owner. AO owns sessions, worktrees, lifecycle and reviews. Each implementation task is one local ticket under `.scratch/auto-track/issues/` (git-excluded, Matt Pocock's local tracker convention). A worker runs `/implement`, driving `/tdd` at agreed seams, and closes with `/code-review` against the ticket before opening its draft PR. `/retro` runs at each milestone. No GSD inside AO workers. This roadmap is the single plan of record on the branch. Reason: decisions stay with the owner, AO already provides the session and review machinery, and one ticket per task gives every worker a bounded, reviewable scope without a second task system.
- Planning-grade documents (roadmap, specs, tickets) are authored by strong models: Claude Opus or GPT Astra at xhigh effort; reviews use the opposite provider (2026-10-22). Reason: these documents steer every later worker, and a reviewer from the other provider is less likely to share the author's blind spots.
- This file lives at `.formalising/auto-fv/ROADMAP.md`, tracked on the branch, and is excluded from the npm package by the `package.json` `files` allowlist. In pilot repositories `.formalising/` stays git-excluded as usual; tracking the small canonical auto-fv set there is a development-only exception for FVS 3.0. Reason: the plan must travel with the branch that implements it, but it is not user-facing product content.
- Packaging: four member commands plus a one-file `/fvs:auto` router; four workflows; one new zero-dependency script `scripts/fvs-auto.mjs` (subcommands `profile`, `roots`, `closure`, `freeze`, `accept`, `check`, `state`) with JSON output and human-readable errors. Pinned counts move from 30 to 35 commands and from 18 to 22 workflows; the help and README parity tests apply. Reason: the router keeps the entry point small, and one script without dependencies keeps state handling deterministic and unit-testable.
- Extraction: SPQR-style translation patches become the default of the shared `aeneas-extract`. There is one patch per function by default, applied only while Charon runs and reverted afterwards, with a patches-check. The existing `src-modifications.diff` ledger behaviour gets a documented migration path. `auto-extract` uses the shared extractor; there is no competing extractor. Reason: patches keep the original source untouched outside the extraction window, and a single extractor keeps one place where correspondence evidence is produced. The migration contract (2026-10-22):
  - One documented mode key, working name `extraction.mode` = `translation-patches` | `legacy-source-ledger`; the final name is settled at implementation review.
  - Existing projects with a legacy ledger keep the legacy interpretation until they migrate explicitly; nothing is reinterpreted silently. Ambiguous mixed active records fail. No ledger is deleted automatically.
  - Migration preserves each change's classification, assumptions, correspondence obligations, assessor evidence and human ratification.
  - Each run records the base source identity, the ordered patch hashes and the expected pre and post states. A stale patch fails clearly and is never fuzzy-applied. Patches are preferably applied in a disposable extraction copy.
  - "One patch per function" is a default; a classified supporting patch is allowed.
  - Completion reports four things separately: extraction success, restored source, valid evidence, and the correspondence obligations that remain.
  - The CHANGELOG names the breaking default for new projects, the unchanged legacy handling until migration, the migration procedure, and the fact that translation adaptations do not prove equivalence with the original source.
- Publishing during development: workers push `feat/auto-track` and their worker branches and open draft PRs targeting `feat/auto-track`; the coordinator merges after a green AO review and CI. Main, tags and releases are untouched. Reason: the work stays reviewable and reversible without touching the released product.
- Pilot: a `libcrux-verify` repository under BAIF, created by the owner, using this branch. Workers get FVS through a per-worktree local install from the feature-branch checkout, recorded with its commit in the pilot state. Claude Code authors, with Codex reviewers. Proof-related reviews use fresh FVS-equipped review sessions, not AO's generic Review button. Defaults: 2 hours of proof budget per node, 3 concurrent workers, and one total wall-clock cap named at auto-init. Extensions require owner approval and are recorded. Reason: a real target with fixed limits shows what the track can do and what it costs.
- Scouting of libcrux-ml-kem 0.0.8 (the version libsignal pins) runs now as a standalone read-only worker. Its output is a feasibility note, not a repository. Reason: extraction risks surface before the pilot repository exists.
- Peer review: Dot (the owner's desktop assistant) reviews plans through the git-excluded folder `.formalising/auto-fv/dot-exchange/` (requests `*-FOR-DOT.md`, replies `*-DOT-REPLY.md`). Advice only; the owner decides (2026-10-22). Reason: a second reader challenges plans before work starts, without adding another decision maker.

## Architecture and ownership

Four parties share the work, and each owns one kind of decision.

- AO coordinates: sessions, worktrees, the default branch as the place where the accepted baseline is materialised, session JSON for restart reconciliation, `ao report`, and a rules file on the pilot project only.
- FVS guides the verification: onboarding, extraction, scope selection, specification and review, proof work, and recovery.
- Small deterministic tools enforce state: `scripts/fvs-auto.mjs`.
- Independent checks decide acceptance. A worker's success message, a reviewer's opinion or an AO task completion is not a proof receipt.

Constraints and clarifications:

- The auto commands require AO on the host and fail with an actionable message otherwise.
- The accepted baseline commit is named in `state.json`. "Default branch" is only how AO materialises it.
- AO session JSON and PR claims are discovery hints. On resume, the coordinator reconciles the actual worktree, branch, commit and accepted receipt before dispatching anything.
- The effective worker rules and profile are recorded; nobody assumes a rules-file flag was honoured.
- Each shared helper has exactly one owner. Acceptance and integration are serialized: three worker slots are not three simultaneous merges.
- Only the coordinator writes receipts.
- Never run `ao project set-config` with focused flags: it replaces the whole configuration and drops the effort setting.
- Threat model, stated plainly: coordinator-only receipt writing is a workflow rule, not filesystem isolation. Worktrees separate edits; they do not contain hostile code. No adversarial-isolation claim is made.

### Acceptance procedure

1. Select the exact candidate commit and an immutable snapshot; record any permitted uncommitted input explicitly.
2. Run the accepted checker and policy from outside the candidate's changes. Bind the result to the checker and policy version, the toolchain and dependency identities, the reviewed spec fingerprints, and the source and extraction identities.
3. Rebuild the intended targets under controlled configuration. Stale `.olean` files or an edited lakefile never satisfy the check. Verify the selected root set and dependency coverage, not only a zero exit code.
4. Compare the frozen statements and their semantically relevant type and definition dependencies; inspect the transitive axioms of both the theorem and its expected type.
5. Write the receipt from the checker result, then reconcile integration; recheck the integrated tree if it differs from the checked candidate. A PR review, a green badge or a worker's self-report never substitutes for this step.
6. Missing, malformed, timed-out, stale or scope-mismatched evidence is not accepted. Resume invalidates every receipt whose bound inputs changed.

Axiom policy for auto acceptance: `propext`, `Classical.choice` and `Quot.sound` only. `sorryAx`, `Lean.ofReduceBool` (what `native_decide` introduces) and custom axioms are rejected. The trust-audit command's justified-custom-axiom CLEAN taxonomy is reused for introspection only, never as the auto acceptance policy.

## Components to reuse

- `scripts/fvs-probe-inventory.mjs`: its `resolve`, `install` and `run` subcommands (`resolveProbe`, `installProbe`) and its dependents, the `map-code`, `fc-plan` and `trust-audit` workflows. The inventory's `topLevelFunctions` and `entryPointFunctions` sets supply root candidates. `TESTED_TUPLES`, whose only entry today is `aeneas-6e167c9b-charon-0.1.225-lean-v4.31.0`, seeds the compatibility profile.
- `fv-skills/workflows/aeneas-extract.md`: the shared extractor, including its synchronous Category-B equivalence gate with an independent assessor and human ratification.
- `lean-specify` and `lean-spec-review` (commands in `commands/fvs/`, workflows in `fv-skills/workflows/`), with review requests sent as JSON through `scripts/fvs-spec-review.mjs`.
- The 2.3.8 `lean-verify` loop (`fv-skills/workflows/lean-verify.md`): the autonomous proof loop, its wall-clock budget, and the cheat audit that gates VERIFIED. The `check` subcommand of `fvs-auto.mjs` shares one deterministic mechanism with this cheat audit: factor it narrowly, keep one implementation and one policy, and add no second cheat audit.
- The `trust-audit` `#print axioms` harness (`fv-skills/workflows/trust-audit.md`).
- From AutoFV (`auto_verify_dalek`, branch `ada/autofv-pipeline`), only the deterministic logic: closure and bottom-up ordering, stale-contract rejection, failed-helper blocking, statement fingerprints, expected types via used constants, the axiom whitelist and the receipt shape. Nothing from its VM, provider or scheduling runtime is reused.

Lessons carried over from the libsignal-verify PR 17 retrospective:

- Losing generated operations must fail acceptance.
- An axiom inventory is not a contract.
- Outputs bind to a complete run manifest.

## Missing interfaces

- The four member commands, the `/fvs:auto` router and the four workflows.
- `scripts/fvs-auto.mjs` with the subcommands listed under Decisions.
- The `.formalising/auto-fv/` layout: `ROADMAP.md` (this file), `state.json` (including the accepted baseline commit and the effective worker rules and profile), `receipts/`, and the externals record written by auto-extract.
- The externals record, one entry per boundary, holding: a stable id; the original source symbol and commit; the extracted or handwritten model symbol and its hash; the exact claimed behaviour; the reason for the boundary; the affected roots; evidence links; a status, which is one of correspondence proved for the recorded identities, explicitly accepted assumption with conditional downstream claims, or unresolved blocker; and the reviewer or owner decision. The Category-B assessor and human ratification record from the aeneas-extract workflow are reused. The checker carries every open correspondence obligation forward; a replacement definition never closes one. Acceptance of a limitation is labelled as such, not as proof.
- A shipped worker-rules reference for AO pilot sessions.
- Config keys for the extraction mode and the compatibility profile.

## Tests

- Unit tests on a recorded probe envelope with two roots sharing one helper: closure, single owner, a cycle fails closed, a stale contract is rejected, a failed helper blocks its consumers, and restart reconciliation against fake session JSON.
- Checker negatives, each of which must FAIL: an introduced axiom; `sorryAx`; `native_decide`; a statement edit; a type-dependency change; a lakefile `leanOptions` change; a changed referenced definition or instance; a type-only axiom dependency; a modified validation configuration; stale compiled artifacts; a stale receipt after integration; missing audit output.
- Patch-mode tests: clean success; extraction failure; interruption and recovery; pre-existing dirty files; already-applied and stale patches; overlapping and order-dependent patches; mixed-mode configuration; faithful migration of A/B classifications; byte-for-byte restoration of the touched source set.
- Compatibility-profile verdicts on fixture tuples.
- Count-pin and parity updates for the new commands and workflows.

Recorded probe fixtures are labelled as fixtures, never as a real extraction. `npm test` cannot run Charon, Aeneas or the probe. The tracer run on stock AO is a documented manual demonstration, with its evidence kept in session artifacts.

## Milestones

Each milestone ends with a fresh review session and a retrospective. At every milestone the report keeps four things apart: setup, qualification, actual model execution, and independently checked results.

1. Tooling and onboarding. Done when the four commands, the router, the four workflows and `scripts/fvs-auto.mjs` exist with the unit and checker tests above passing, the count pins and parity tests are updated, and a newcomer can follow auto-init from a clean host to a recorded state.
2. Small integration tracer. Two roots share a helper, using a pure-Lean fixture plus a recorded probe envelope, run through a temporary AO project. Done when the run shows both an acceptance and a rejection, and the negative cases for a stale contract, a failed helper and an interrupted session behave as specified. The pilot does not scale until both outcomes have been shown.
3. Real pilot in the owner's `libcrux-verify` checkout. One primitive and one configuration, at an exact upstream revision, with a stated scope, stated assumptions and end-to-end evidence. Done when extraction, reviewed specifications, checked Lean proof results and the remaining correspondence assumptions are each reported separately.
4. Review for FVS 3.0. Done when the track has had a full review and the owner decides on the release.

Pilot specifics:

- The pilot's extraction tuple (Aeneas nightly-2026.09.30-0855ce1, Charon 0.1.274, Lean 4.31.0) is "available but unverified" in the probe resolver, whose only tested tuple is Aeneas 6e167c9b with Charon 0.1.225, until a confined run is recorded.
- The scout's evidence is at libcrux-ml-kem 0.0.8, while the pilot pins 0.0.10, so extraction, the lockfile, features and include settings are revalidated at the chosen revision.
- Pilot report wording: "This pilot evaluates the FVS auto workflow on a pinned portable libcrux NTT component. The selected component overlaps existing F* verification. We report extraction, reviewed specifications, checked Lean proof results and remaining correspondence assumptions separately. This is not a new verification of all libcrux, ML-KEM, constant-time behaviour, SIMD implementations, or an end-to-end protocol."

Platform claims: macOS arm64 is supported and tested. Linux x64 is not yet validated and stays so until the probe's Linux branch lands. Everything else is unsupported.

## Owner-reserved actions

Only the owner:

- creates or publishes a BAIF repository, or changes a repository's visibility;
- merges to main;
- cuts releases;
- approves system-wide tool installs;
- approves unbounded model spending;
- requests Oliver's input on Aeneas extraction.

## Non-goals

- No AO reimplementation, provider runtime, dashboard, sandbox framework or all-platform installer.
- No protocol or computational-security claims.
- No whole-libcrux claim.
- No MCP layer.
- No automatic merges or releases.

## Status log

| Date | Entry |
|---|---|
| 2026-10-21 | decisions confirmed; branch created; scouting started |
| 2026-10-22 | Dot kickoff review received; advice folded into this roadmap |
| 2026-10-22 | `feat/auto-track` fast-forwarded to the current `release/2.3.8` tip |
| 2026-10-22 | workers moved to local tickets under `.scratch/auto-track/issues/` and the implement, review and retro loop |
