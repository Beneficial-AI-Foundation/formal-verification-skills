---
name: fvs-protocol-prose
description: Improve protocol formalisation prose for a file or topic while preserving formal content
---

<pi_package_runtime>
- This skill lives under `pi/skills/<name>/SKILL.md`; the FVS package root is `../../..` relative to its directory.
- Resolve every bundled relative path against the skill directory and pass absolute paths to tool calls and shell commands.
- Agent role instructions live under `../../../agents/`. When a workflow requests Task/subagent dispatch, use an available Pi subagent facility with the matching role instructions. If none is installed, perform the role inline and state that fresh-context separation was unavailable. Exception: a review workflow that requires a fresh reviewer must remain pending or offer its documented fallback; never perform that review inline.
- Use Pi's structured question tool when available; otherwise ask the same question in plain text.
- Never write state into the managed package. Project state belongs under the user's current project (normally `.formalising/`).
</pi_package_runtime>

<objective>
Opt-in prose revision for a protocol file or bounded paper-track topic. Improve existing
explanations using the source paper's terminology and the target repository's conventions.
Preserve Lean definitions, statements and proofs, and the scientific meaning of the prose.
Run in the current session; no additional model call or review stage.
</objective>

<execution_context>
@../../../fv-skills/workflows/protocol-prose.md
@../../../fv-skills/references/protocol-prose.md
</execution_context>

<process>
Follow the protocol-prose workflow for `$ARGUMENTS`. Treat the argument as a file or topic
identifier, never shell code. Resolve an explicit edit boundary before writing. The workflow
owns source/convention discovery, the prose-only comparison, build checks and final report.
</process>
