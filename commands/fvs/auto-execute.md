---
name: fvs:auto-execute
description: Continue authorized dependency-ready proof work through checked acceptance and a human review bundle
argument-hint: ""
allowed-tools:
  - Read
  - Write
  - Bash
  - Skill
---

<objective>
For the actual v2 AO orchestrator with current applicable agreement, explicit execution grant,
resolved role profile and controller context, run the production driver through dependency-ready
proof work, serial independent15 acceptance and the17 human bundle. Each effect needs its exact
paired current checks; worker reports and driver results establish no proof acceptance.
Legacy/read-only and missing-context invocations retain the reporting stop without dispatch.
</objective>

<execution_context>
@~/.claude/fv-skills/workflows/auto-execute.md
@~/.claude/fv-skills/references/ui-brand.md
</execution_context>

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

Follow the auto-execute workflow. Finish with its report block, which always carries the
`State:`, `Next action:` and `Pending decision:` lines.
</process>

<success_criteria>
- [ ] Reports the recorded state read through `fvs-auto.mjs read-state`, or why it cannot.
- [ ] Legacy/read-only routes stop with "milestone 2 functionality not yet available" without dispatch.
- [ ] Reconciles configured continuation through the current caller request, or reports the actual partial reason.
- [ ] Preserves original scope, execution policy and reservations; v2 alone grants no dispatch.
- [ ] Stale accepted stores use only existing validated v2basis continuations, never cleared history.
- [ ] Only current15 receipts count as accepted proofs; whole-scope currentness remains strict.
- [ ] Final17 output lists every failed/unsupported root and leaves human approval pending.
- [ ] PR publication requires its separate explicit grant.
</success_criteria>
