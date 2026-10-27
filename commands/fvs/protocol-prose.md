---
name: fvs:protocol-prose
description: Improve protocol formalisation prose for a file or topic while preserving formal content
argument-hint: "<file-or-topic>"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
  - Write
---

<objective>
Opt-in prose revision for a protocol file or bounded paper-track topic. Improve existing
explanations using the source paper's terminology and the target repository's conventions.
Preserve Lean definitions, statements and proofs, and the scientific meaning of the prose.
Run in the current session; no additional model call or review stage.
</objective>

<execution_context>
@~/.claude/fv-skills/workflows/protocol-prose.md
@~/.claude/fv-skills/references/protocol-prose.md
</execution_context>

<process>
Follow the protocol-prose workflow for `$ARGUMENTS`. Treat the argument as a file or topic
identifier, never shell code. Resolve an explicit edit boundary before writing. The workflow
owns source/convention discovery, the prose-only comparison, build checks and final report.
</process>
