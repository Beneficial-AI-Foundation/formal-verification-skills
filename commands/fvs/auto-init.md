---
name: fvs:auto-init
description: Single entry for the auto track: show every stage's readiness, then reuse or record the agreement
argument-hint: ""
allowed-tools:
  - Read
  - Write
  - Bash
  - AskUserQuestion
  - Skill
---

<objective>
Start or resume the auto track through the AO orchestrator, the single entry. Show the compatibility
profile with every stage's readiness up front, then reuse a current applicable agreement without
Keep/Change or repeated interviewing. Use a short `/fvs:roadmap` light/deep/reuse conversation only
for what is missing: the source revision, the agreed scope (crates, modules and features), boundaries,
conventions, single-crate/monorepo layout, execution choices and the repository the draft pull
requests go to. A helper drafts the agreement and the owner only confirms it.

Persist choices and the exact declared agreement through `scripts/fvs-auto.mjs`; use the mandatory
`read-state --require-agreement` stored-context gate AND the workflow's canonical semantic check.
A roadmap-offer decision alone is not agreement or authorization. Material changes need explicit
confirmation; routine progress does not reopen setup. Public-API selection is not supported in this
release.

Output: recorded setup and agreement, and the next stage or the exact refusal. Agreement storage alone
launches no workers or proofs. The pipeline after it is fixed and the agents choose how: extract, a
draft spec pull request the owner merges, proofs, FVS's build check in a fresh clean copy, a draft proof
pull request. Later provisional cycles stay autonomous within the agreement and final PR acceptance
stays human.
</objective>

<execution_context>
@~/.claude/fv-skills/workflows/auto-init.md
@~/.claude/fv-skills/references/auto-setup.md
@~/.claude/fv-skills/references/auto-memory.md
@~/.claude/fv-skills/references/ui-brand.md
</execution_context>

<context>
Run from the project root (the Lean project that holds `lakefile.toml` and `lean-toolchain`).
State lives under `.formalising/auto-fv/`; `auto-setup.md` explains how to keep `.formalising/`
out of git. Fresh rc1 setup requires the declared Aeneas/Charon executables locally even for an
externally prepared, validated extraction. A retained witness does not bypass `profile-blocked`;
see the prerequisite and exact-source installation steps in `auto-setup.md`.
</context>

<process>

## Rc1 human-feedback boundary

For AUTO owner feedback that revises previously reviewed contracts after end/partial results,
report `unsupported: human re-specification is not available in 3.0.0-rc1` and stop before
state/agreement/registry changes, revision effects or provider dispatch. Apply this to direct
requests and resumed handoff instructions. Keep the actual feedback, complete selected scope,
original accounting and each root's failed/unsupported/partial reason. No ready/success claim follows.
Initial autonomous specify/review/revise/prove and ordinary safe resume remain available under their
existing gates; stale proofs still need current checker receipts. Internal diagnostic APIs do not
authorize a public re-specification run.

Follow the auto-init workflow end to end. Every state change goes through `fvs-auto.mjs`; never
write or edit `state.json` by hand, and never pass `--confirm-overwrite` without the owner's
explicit confirmation of the listed changes.

Agents may open draft pull requests and edit a pull request body. They never post comments or reviews
on GitHub, never mark a pull request ready and never merge: only the owner comments, marks ready and
merges.

Finish with the workflow's report block, which always carries the `State:`, `Next action:` and
`Pending decision:` lines.
</process>

<codex_skill_adapter>
On Codex, every owner question in this command (the choices, a confirmation of changed choices and
the initial roadmap agreement) degrades to a plain-text question and WAITS for the answer. It is fail-closed:
it never picks a default for the owner, never runs `init-state` before the owner has answered,
and never passes `--confirm-overwrite` or records owner agreement/authority on the owner's behalf.
Applicable existing explicit responses are reused without another question; computing a hash is not approval.
</codex_skill_adapter>

<success_criteria>
- [ ] Stops with an actionable message when `ao` is not on PATH.
- [ ] Malformed state stops with the script's message and next step; it is never overwritten.
- [ ] The profile is shown with its stage lines before any question; a `profile-blocked` result stops with every blocking item's next step.
- [ ] Owner choices are recorded only through `init-state`; an unchanged rerun writes nothing.
- [ ] A changed choice is shown to the owner and written only after explicit confirmation.
- [ ] A current applicable agreement bypasses Keep/Change and repeated interviews; actual evidence is read.
- [ ] Missing/stale agreement stops the M2 route; legacy M1 offer/extraction records keep their meaning.
- [ ] Actual retained payload and current roadmap fence bind approval; status-only logs do not re-grill.
- [ ] Stored-context-current is distinguished from the mandatory semantic applicability check.
- [ ] The configured memory route uses a primary store and fresh caller request/actual prime bytes on start/resume.
- [ ] Worker prime is read-only; missing real stores are never initialized or migrated automatically.
- [ ] No public-API classifier, implicit grant or per-round human approval is introduced.
- [ ] Agreement storage alone launches no workers; a recorded draft pull request destination is the project's own repository.
- [ ] The report carries the State, Next action and Pending decision lines.
</success_criteria>
