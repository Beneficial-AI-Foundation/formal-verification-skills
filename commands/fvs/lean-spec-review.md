---
name: fvs:lean-spec-review
description: Adversarially review an FC Lean specification with a chosen runtime, model, and effort
argument-hint: "<spec.lean> [--reviewer codex|claude|other] [--model ID] [--effort LEVEL]"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
  - Write
  - AskUserQuestion
  - Task
---

<objective>
Review one FC specification against Rust and extracted Lean sources before proof work. Offer a
runtime, model, and effort menu; preserve the spec and record the review and finding triage.
</objective>

<execution_context>
@~/.claude/fv-skills/workflows/lean-spec-review.md
@~/.claude/fv-skills/references/fc-spec-review.md
</execution_context>

<process>
Follow the review workflow with `$ARGUMENTS`. Explicit invocation always runs the selection flow,
even when `spec_review.automatic` is false. Automatic invocation from `lean-specify` enters the
same workflow after generation checks, with the resolved spec/source paths and author runtime.
</process>
