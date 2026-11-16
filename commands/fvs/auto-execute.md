---
name: fvs:auto-execute
description: Prove the merged spec statements, let FVS's build check decide accepted, and open a draft proof pull request
argument-hint: ""
allowed-tools:
  - Read
  - Write
  - Bash
  - Skill
---

<objective>
For the AO orchestrator, once the owner has merged the spec pull request: workers prove the statements,
one proof file per Rust item (complete first, improve later). FVS's build check, run in a fresh clean
copy, decides what is accepted. The proof pull request follows as a draft on the project's own
repository, and spec refactors found while proving arrive as new draft pull requests. The goal and the
pipeline are fixed; how the workers get there is theirs to decide.
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

Agents may open draft pull requests and edit a pull request body. They never post comments or reviews
on GitHub, never mark a pull request ready and never merge: only the owner comments, marks ready and
merges.
</process>

<success_criteria>
- [ ] Reports the recorded state read through `fvs-auto.mjs read-state`, or why it cannot.
- [ ] Starts only after the owner has merged the spec pull request.
- [ ] Statements stay unchanged while proving; a wrong or weak one becomes a refactor draft pull request.
- [ ] Only FVS's build check in a fresh clean copy counts as accepted; worker reports establish no acceptance.
- [ ] The proof pull request is a draft on the project's own repository; every unproved item is listed with its reason.
- [ ] Nothing is posted as a GitHub comment or review.
</success_criteria>
