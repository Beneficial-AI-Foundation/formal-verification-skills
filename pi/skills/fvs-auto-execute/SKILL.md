---
name: fvs-auto-execute
description: Prove the merged spec statements, let FVS's build check decide accepted, and open a draft proof pull request
---

<pi_package_runtime>
- This skill lives under `pi/skills/<name>/SKILL.md`; the FVS package root is `../../..` relative to its directory.
- Resolve every bundled relative path against the skill directory and pass absolute paths to tool calls and shell commands.
- Agent role instructions live under `../../../agents/`. When a workflow requests Task/subagent dispatch, use an available Pi subagent facility with the matching role instructions. If none is installed, perform the role inline and state that fresh-context separation was unavailable. Exception: a review workflow that requires a fresh reviewer must remain pending or offer its documented fallback; never perform that review inline.
- Use Pi's structured question tool when available; otherwise ask the same question in plain text.
- Never write state into the managed package. Project state belongs under the user's current project (normally `.formalising/`).
</pi_package_runtime>

<objective>
For the AO orchestrator, once the owner has merged the spec pull request: workers prove the statements,
one proof file per Rust item (complete first, improve later). FVS's build check, run in a fresh clean
copy, decides what is accepted. The proof pull request follows as a draft on the project's own
repository, and spec refactors found while proving arrive as new draft pull requests. The goal and the
pipeline are fixed; how the workers get there is theirs to decide.
</objective>

<execution_context>
@../../../fv-skills/workflows/auto-execute.md
@../../../fv-skills/references/ui-brand.md
</execution_context>

<process>

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
