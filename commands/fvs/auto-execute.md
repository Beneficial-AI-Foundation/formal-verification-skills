---
name: fvs:auto-execute
description: Reconcile configured auto-track checkpoints and report state; automatic dispatch remains unavailable
argument-hint: ""
allowed-tools:
  - Read
  - Bash
---

<objective>
Read the recorded state, reconcile an agreed configured coordinator continuation and report it.
The bounded adapter records runtime checkpoints/current observations; automatic dispatch and stage
sequencing remain unavailable. This invocation accepts no proof.
</objective>

<execution_context>
@~/.claude/fv-skills/workflows/auto-execute.md
@~/.claude/fv-skills/references/ui-brand.md
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
