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

Honor explicit reviewer/model/effort choices. Supplying all three standalone flags is the
non-interactive path; otherwise ask only for missing choices in order: reviewer -> model -> effort.
Automatic callers record `Skip review` exactly as `Unreviewed (user skipped)` and do not auto-start
proof work.

The reviewer is read-only; the `lean-specify` authoring seat keeps `review.md` unchanged and writes
separate `triage.md` with finding IDs, old/new hashes (pre-edit/post-edit), and rerun structure,
style, and optional build gates. PASS is terminal. APPROVE-WITH-EDITS becomes `approved after edits`
after accepted bounded edits pass those gates, with no second review. REVISE and BLOCKED
require a fresh revision or evidence packet and another review with prior review/triage history.
Run at most three reviewer rounds per invocation; stop at the cap with an exact resume command.
</process>
