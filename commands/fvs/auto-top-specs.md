---
name: fvs:auto-top-specs
description: Explain the recorded auto-track state; root selection and top-level specifications are milestone 2 functionality
argument-hint: ""
allowed-tools:
  - Read
  - Bash
---

<objective>
Explain the recorded auto-track state and stop: selecting roots and freezing top-level
specifications is milestone 2 functionality not yet available. Nothing is selected, specified,
frozen or written.
</objective>

<execution_context>
@~/.claude/fv-skills/workflows/auto-top-specs.md
@~/.claude/fv-skills/references/ui-brand.md
</execution_context>

<process>
Follow the auto-top-specs workflow. Finish with its report block, which always carries the
`State:`, `Next action:` and `Pending decision:` lines.
</process>

<success_criteria>
- [ ] Reports the recorded state read through `fvs-auto.mjs read-state`, or why it cannot.
- [ ] Stops with "milestone 2 functionality not yet available" and the pointer to the README's auto track section.
- [ ] Writes nothing and starts no partial root selection or specification work.
</success_criteria>
