---
name: fvs:auto-init
description: Reuse or record the initial roadmap agreement and setup state for the auto track
argument-hint: ""
allowed-tools:
  - Read
  - Write
  - Bash
  - AskUserQuestion
  - Skill
---

<objective>
Start or resume the auto track through the AO orchestrator master entry. Inspect the compatibility
profile and existing state, then reuse a current applicable initial roadmap agreement without
Keep/Change or repeated interviewing. Use `/fvs:roadmap` light/deep/reuse only for missing initial
scope, boundaries, conventions, single-crate/monorepo layout and execution choices. No top-level
specifications are required initially.

Persist choices and the exact declared agreement through `scripts/fvs-auto.mjs`; use the mandatory
`read-state --require-agreement` stored-context gate AND the workflow's canonical semantic check.
A roadmap-offer decision alone is not agreement or authorization. Material changes need explicit
confirmation; routine progress does not reopen setup. Public-API selection remains unsupported
pending separately permitted visibility landing.

Output: recorded setup/agreement and the available continuation or exact refusal. This bounded
slice launches no workers, extracts/proves nothing and does not implement target memory20, full
resume16 or orchestration22. Later provisional cycles stay autonomous within the agreement and
final PR acceptance stays human.
</objective>

<execution_context>
@~/.claude/fv-skills/workflows/auto-init.md
@~/.claude/fv-skills/references/auto-setup.md
@~/.claude/fv-skills/references/ui-brand.md
</execution_context>

<context>
Run from the project root (the Lean project that holds `lakefile.toml` and `lean-toolchain`).
State lives under `.formalising/auto-fv/`; `auto-setup.md` explains how to keep `.formalising/`
out of git.
</context>

<process>
Follow the auto-init workflow end to end. Every state change goes through `fvs-auto.mjs`; never
write or edit `state.json` by hand, and never pass `--confirm-overwrite` without the owner's
explicit confirmation of the listed changes.

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
- [ ] The profile is shown; a `profile-blocked` result stops with every blocking item's next step.
- [ ] Owner choices are recorded only through `init-state`; an unchanged rerun writes nothing.
- [ ] A changed choice is shown to the owner and written only after explicit confirmation.
- [ ] A current applicable agreement bypasses Keep/Change and repeated interviews; actual evidence is read.
- [ ] Missing/stale agreement stops the M2 route; legacy M1 offer/extraction records keep their meaning.
- [ ] Actual retained payload and current roadmap fence bind approval; status-only logs do not re-grill.
- [ ] Stored-context-current is distinguished from the mandatory semantic applicability check.
- [ ] No public-API classifier, implicit grant, per-round human approval or worker dispatch is introduced.
- [ ] The report carries the State, Next action and Pending decision lines.
</success_criteria>
