---
name: fvs-auto-top-specs
description: Write and adversarially review Lean statements for every public API item in the agreed scope, then open a draft spec pull request
---

<pi_package_runtime>
- This skill lives under `pi/skills/<name>/SKILL.md`; the FVS package root is `../../..` relative to its directory.
- Resolve every bundled relative path against the skill directory and pass absolute paths to tool calls and shell commands.
- Agent role instructions live under `../../../agents/`. When a workflow requests Task/subagent dispatch, use an available Pi subagent facility with the matching role instructions. If none is installed, perform the role inline and state that fresh-context separation was unavailable. Exception: a review workflow that requires a fresh reviewer must remain pending or offer its documented fallback; never perform that review inline.
- Use Pi's structured question tool when available; otherwise ask the same question in plain text.
- Never write state into the managed package. Project state belongs under the user's current project (normally `.formalising/`).
</pi_package_runtime>

<objective>
For the AO orchestrator: after extraction, list every public API item in the agreed scope. Per Rust
file, an author writes the statements and a fresh adversarial reviewer checks them (at most three
rounds). Statements go in `formal/specs/Defs` and `formal/specs/Specs`, one file per Rust file, each
restated with `recall` and a guarded `#print axioms` list; hand-written axioms go in `formal/trusted`.
Open the spec pull request as a draft on the project's own repository, then stop for the owner.
The goal and the pipeline are fixed; how the agents get there is theirs to decide.
</objective>

<execution_context>
@../../../fv-skills/workflows/auto-top-specs.md
@../../../fv-skills/references/ui-brand.md
</execution_context>

<process>
Follow the auto-top-specs workflow. Finish with its report block, which always carries the
`State:`, `Next action:` and `Pending decision:` lines.

Agents may open draft pull requests and edit a pull request body. They never post comments or reviews
on GitHub, never mark a pull request ready and never merge: only the owner comments, marks ready and
merges.
</process>

<success_criteria>
- [ ] Reports the recorded state read through `fvs-auto.mjs read-state`, or why it cannot.
- [ ] Every public API item in the agreed scope is listed; nothing leaves the scope silently.
- [ ] Each Rust file's statements were written by an author and checked by a fresh adversarial reviewer, in at most three rounds.
- [ ] The spec pull request is a draft on the project's own repository, and the agents stop for the owner.
- [ ] Nothing is posted as a GitHub comment or review.
</success_criteria>
