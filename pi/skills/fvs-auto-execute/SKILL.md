---
name: fvs-auto-execute
description: Explain the recorded auto-track state; dispatching and accepting proof work is milestone 2 functionality
---

<pi_package_runtime>
- This skill lives under `pi/skills/<name>/SKILL.md`; the FVS package root is `../../..` relative to its directory.
- Resolve every bundled relative path against the skill directory and pass absolute paths to tool calls and shell commands.
- Agent role instructions live under `../../../agents/`. When a workflow requests Task/subagent dispatch, use an available Pi subagent facility with the matching role instructions. If none is installed, perform the role inline and state that fresh-context separation was unavailable. Exception: a review workflow that requires a fresh reviewer must remain pending or offer its documented fallback; never perform that review inline.
- Use Pi's structured question tool when available; otherwise ask the same question in plain text.
- Never write state into the managed package. Project state belongs under the user's current project (normally `.formalising/`).
</pi_package_runtime>

<objective>
Explain the recorded auto-track state and stop: dispatching proof work to Agent Orchestrator
workers and accepting checked results is milestone 2 functionality not yet available. Nothing is
dispatched, checked, accepted or written.
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
- [ ] Writes nothing, dispatches no worker and accepts no result.
</success_criteria>
