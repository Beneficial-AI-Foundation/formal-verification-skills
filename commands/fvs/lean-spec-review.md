---
name: fvs:lean-spec-review
description: Adversarially review an FC Lean specification with a chosen runtime, model, and effort
argument-hint: "<spec.lean> [--reviewer codex|claude|pi|other] [--model ID] [--effort LEVEL]"
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
@~/.claude/fv-skills/references/model-profiles.md
</execution_context>

<process>
Follow the review workflow with `$ARGUMENTS`. Explicit invocation always runs the selection flow,
even when `spec_review.automatic` is false. Automatic invocation from `lean-specify` enters the
same workflow after generation checks, with the resolved spec/source paths and author runtime.

Declare authority stage `spec_review` and apply `model-profiles.md`. Precedence is explicit one-run
flags, non-null `spec_review.reviewer` / `spec_review.model` / `spec_review.effort`, then the quality
opposite-runtime recommendation. Null saved values keep profile routing active.

Detect the specification authoring runtime. Recommend an authenticated opposite provider/runtime:
OpenAI/Codex-authored specs use Claude Code CLI; Claude-authored specs use a fresh
provider-qualified OpenAI Pi seat when running in Pi, then Codex CLI. Unknown authors receive an
explicit reviewer menu without an independence claim. Never route a Claude Code subscription
through Pi. The `pi` reviewer is available only inside Pi with a provider-qualified model from its
live authenticated catalog and a fresh-child facility that can honor and report the exact per-child
model/effort. It launches a fresh read-only child, never a manual Other packet. Persistence requires
the workflow's completed-child receipt with actual run ID/model/effort and packet/response hashes;
missing capability or evidence leaves the review pending.

Build one review selection manifest containing reviewer runner, provenance, exact catalog model,
and effort. Confirm it before launch with Continue once, Adjust once, Save override, or Cancel;
retain notes. Notes rebuild the manifest and require reconfirmation. Save writes only the
`spec_review` object. Offer every effort value the selected model/provider reports as supported.
Missing models or unsupported efforts ask for one-run/save/cancel; unresolved noninteractive
choices fail before launch with exact remediation.

If no opposite runner is authenticated, ask among setup/retry, fresh same-runtime review, Other
handoff, one-run skip, or cancel; never switch silently. A one-run skip records exactly
`Unreviewed (user skipped)`, stops at the review boundary, and does not auto-start proof work.

The reviewer is read-only; the `lean-specify` authoring seat keeps `review.md` unchanged and writes
separate `triage.md` with finding IDs, old/new hashes (pre-edit/post-edit), and rerun structure,
style, and optional build gates. PASS is terminal. APPROVE-WITH-EDITS becomes `approved after edits`
after accepted bounded edits pass those gates, with no second review. REVISE and BLOCKED
require a fresh revision or evidence packet and another review with prior review/triage history.
Run at most three reviewer rounds per invocation; stop at the cap with an exact resume command.
</process>
