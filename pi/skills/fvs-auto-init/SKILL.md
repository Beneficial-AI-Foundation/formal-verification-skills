---
name: fvs-auto-init
description: Reuse or record the initial roadmap agreement and setup state for the auto track
---

<pi_package_runtime>
- This skill lives under `pi/skills/<name>/SKILL.md`; the FVS package root is `../../..` relative to its directory.
- Resolve every bundled relative path against the skill directory and pass absolute paths to tool calls and shell commands.
- Agent role instructions live under `../../../agents/`. When a workflow requests Task/subagent dispatch, use an available Pi subagent facility with the matching role instructions. If none is installed, perform the role inline and state that fresh-context separation was unavailable. Exception: a review workflow that requires a fresh reviewer must remain pending or offer its documented fallback; never perform that review inline.
- Use Pi's structured question tool when available; otherwise ask the same question in plain text.
- Never write state into the managed package. Project state belongs under the user's current project (normally `.formalising/`).
</pi_package_runtime>

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

Output: recorded setup/agreement and the available continuation or exact refusal. Agreement storage
alone launches no workers or proofs. With complete authorized v2 controller context, continue the
production driver automatically through the agreed stages. Legacy/read-only or missing-grant routes
stop at their recorded continuation. Later provisional cycles stay autonomous within the agreement
and final PR acceptance stays human.
</objective>

<execution_context>
@../../../fv-skills/workflows/auto-init.md
@../../../fv-skills/references/auto-setup.md
@../../../fv-skills/references/auto-memory.md
@../../../fv-skills/references/ui-brand.md
</execution_context>

<context>
Run from the project root (the Lean project that holds `lakefile.toml` and `lean-toolchain`).
State lives under `.formalising/auto-fv/`; `auto-setup.md` explains how to keep `.formalising/`
out of git.
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
- [ ] The configured memory route uses a primary store and fresh caller request/actual prime bytes on start/resume.
- [ ] Worker prime is read-only; missing real stores are never initialized or migrated automatically.
- [ ] No public-API classifier, implicit grant or per-round human approval is introduced.
- [ ] Worker dispatch requires actual authorized v2 controller context and the driver/current effect gates.
- [ ] The report carries the State, Next action and Pending decision lines.
</success_criteria>
