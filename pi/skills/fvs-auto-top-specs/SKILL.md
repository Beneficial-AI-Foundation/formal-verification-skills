---
name: fvs-auto-top-specs
description: Draft and freshly review agreed nonpublic specifications through the authorized AO controller
---

<pi_package_runtime>
- This skill lives under `pi/skills/<name>/SKILL.md`; the FVS package root is `../../..` relative to its directory.
- Resolve every bundled relative path against the skill directory and pass absolute paths to tool calls and shell commands.
- Agent role instructions live under `../../../agents/`. When a workflow requests Task/subagent dispatch, use an available Pi subagent facility with the matching role instructions. If none is installed, perform the role inline and state that fresh-context separation was unavailable. Exception: a review workflow that requires a fresh reviewer must remain pending or offer its documented fallback; never perform that review inline.
- Use Pi's structured question tool when available; otherwise ask the same question in plain text.
- Never write state into the managed package. Project state belongs under the user's current project (normally `.formalising/`).
</pi_package_runtime>

<objective>
For an actual v2 AO orchestrator with current applicable agreement, explicit execution grant,
resolved role profile and controller context, continue agreed nonpublic selection, actual specification
writing and fresh independent review through the production driver. Preserve the complete scope;
the registry records machine review, never human approval or proof acceptance.
Legacy/read-only and missing-context invocations retain the reporting stop without dispatch.
</objective>

<execution_context>
@../../../fv-skills/workflows/auto-top-specs.md
@../../../fv-skills/references/ui-brand.md
</execution_context>

<process>
Follow the auto-top-specs workflow. Finish with its report block, which always carries the
`State:`, `Next action:` and `Pending decision:` lines.
</process>

<success_criteria>
- [ ] Reports the recorded state read through `fvs-auto.mjs read-state`, or why it cannot.
- [ ] Legacy/read-only routes stop with "milestone 2 functionality not yet available" without writes or dispatch.
- [ ] V2 alone grants nothing: missing agreement/grant/profile/controller/capability remains partial.
- [ ] Authorized selection uses actual10/21/13 identities; public-API mode stays held.
- [ ] An actual author and fresh reviewer use distinct issued assignments; Other responses are bound to14 before dispatch.
- [ ] Edits/failed reviews iterate within the original agreement; changed candidate/head requires fresh review.
</success_criteria>
