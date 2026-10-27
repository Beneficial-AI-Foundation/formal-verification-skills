---
name: fvs-auto-extract
description: Extract the recorded revision through the shared aeneas-extract and record the extraction and its externals
---

<pi_package_runtime>
- This skill lives under `pi/skills/<name>/SKILL.md`; the FVS package root is `../../..` relative to its directory.
- Resolve every bundled relative path against the skill directory and pass absolute paths to tool calls and shell commands.
- Agent role instructions live under `../../../agents/`. When a workflow requests Task/subagent dispatch, use an available Pi subagent facility with the matching role instructions. If none is installed, perform the role inline and state that fresh-context separation was unavailable. Exception: a review workflow that requires a fresh reviewer must remain pending or offer its documented fallback; never perform that review inline.
- Use Pi's structured question tool when available; otherwise ask the same question in plain text.
- Never write state into the managed package. Project state belongs under the user's current project (normally `.formalising/`).
</pi_package_runtime>

<objective>
Extract the source revision and configuration that `/fvs:auto-init` recorded, by handing off to the
shared extractor `/fvs:aeneas-extract` in translation-patch mode; there is no second extractor.
Then record the result with `scripts/fvs-auto.mjs record-extraction`, which derives success itself
from the build exit status and the patch engine's checks, write the externals record (every opaque,
external, handwritten-model or semantic-patch boundary) with `record-externals`, and write the
regeneration instructions.

A failed extraction is never recorded as success, and recorded boundaries are never dropped.
Extraction success is not a proof: it says nothing about any specification.

Output: the extraction record in `.formalising/auto-fv/state.json`, the externals record in
`.formalising/auto-fv/externals.json` and `.formalising/auto-fv/regenerate.md`.
</objective>

<execution_context>
@../../../fv-skills/workflows/auto-extract.md
@../../../fv-skills/references/extraction-patch-migration.md
@../../../fv-skills/references/ui-brand.md
</execution_context>

<context>
Crate path: $ARGUMENTS (the crate root with `Cargo.toml`; asked for when absent). Run from the
project root that holds `.formalising/auto-fv/state.json`.
</context>

<process>
Follow the auto-extract workflow end to end. Every state change goes through `fvs-auto.mjs`; never
write or edit `state.json` or `externals.json` by hand. The aeneas-extract run keeps all of its own
gates, its success oracle and its human ratification.

Finish with the workflow's report block, which always carries the `State:`, `Next action:` and
`Pending decision:` lines.
</process>

<codex_skill_adapter>
On Codex, the halts inherited from `/fvs:aeneas-extract` and every owner question here degrade to a
plain-text question and WAIT for the answer. It is fail-closed: it never ratifies a gate packet,
never accepts an assumption for the owner, and never records an extraction or a boundary status the
owner or the scripts have not decided.
</codex_skill_adapter>

<success_criteria>
- [ ] Stops with an actionable message when `ao` is not on PATH or no setup state is recorded.
- [ ] Stops on a legacy or mixed extraction mode; the command never migrates.
- [ ] Extraction runs through `/fvs:aeneas-extract`, unchanged.
- [ ] `record-extraction` runs after every extraction attempt, success or failure, with the copy and the build's real exit status; its derived status is reported as is.
- [ ] Every boundary has an externals record; recorded boundaries are resubmitted, never dropped.
- [ ] Regeneration instructions are written from the recorded state.
- [ ] The report keeps extraction, restored source, evidence and remaining obligations apart and says extraction success is not a proof.
- [ ] The report carries the State, Next action and Pending decision lines.
</success_criteria>
