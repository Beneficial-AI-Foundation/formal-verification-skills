---
name: fvs-auto-execute
description: Reconcile configured auto-track checkpoints and report state; automatic dispatch remains unavailable
---

<pi_package_runtime>
- This skill lives under `pi/skills/<name>/SKILL.md`; the FVS package root is `../../..` relative to its directory.
- Resolve every bundled relative path against the skill directory and pass absolute paths to tool calls and shell commands.
- Agent role instructions live under `../../../agents/`. When a workflow requests Task/subagent dispatch, use an available Pi subagent facility with the matching role instructions. If none is installed, perform the role inline and state that fresh-context separation was unavailable. Exception: a review workflow that requires a fresh reviewer must remain pending or offer its documented fallback; never perform that review inline.
- Use Pi's structured question tool when available; otherwise ask the same question in plain text.
- Never write state into the managed package. Project state belongs under the user's current project (normally `.formalising/`).
</pi_package_runtime>

<objective>
Read the recorded state, reconcile an agreed configured coordinator continuation and report it.
The bounded adapter records runtime checkpoints/current observations; automatic dispatch and stage
sequencing remain unavailable. This invocation accepts no proof.
</objective>

<execution_context>
@../../../fv-skills/workflows/auto-execute.md
@../../../fv-skills/references/ui-brand.md
</execution_context>

<process>
Follow the auto-execute workflow. Finish with its report block, which always carries the
`State:`, `Next action:` and `Pending decision:` lines.
</process>

<success_criteria>
- [ ] Reports the recorded state read through `fvs-auto.mjs read-state`, or why it cannot.
- [ ] Stops with "milestone 2 functionality not yet available" and the pointer to the README's auto track section.
- [ ] Reconciles configured continuation through the current caller request, or reports the actual partial reason.
- [ ] Preserves original scope/budgets/reservations, dispatches no worker and accepts no proof.
</success_criteria>
