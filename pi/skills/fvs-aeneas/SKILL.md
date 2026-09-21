---
name: fvs-aeneas
description: aeneas extraction | extract repair-loop pins sync
---

<pi_package_runtime>
- This skill lives under `pi/skills/<name>/SKILL.md`; the FVS package root is `../../..` relative to its directory.
- Resolve every bundled relative path against the skill directory and pass absolute paths to tool calls and shell commands.
- Agent role instructions live under `../../../agents/`. When a workflow requests Task/subagent dispatch, use an available Pi subagent facility with the matching role instructions. If none is installed, perform the role inline and state that fresh-context separation was unavailable. Exception: a review workflow that requires a fresh reviewer must remain pending or offer its documented fallback; never perform that review inline.
- Use Pi's structured question tool when available; otherwise ask the same question in plain text.
- Never write state into the managed package. Project state belongs under the user's current project (normally `.formalising/`).
</pi_package_runtime>

Route to the appropriate aeneas-extraction skill based on the user's intent.

When invoked WITH a request, match it against the table below and invoke the matched skill immediately, forwarding the request. When invoked BARE (no request), print this table as plain text and let the user reply free-form.

| User wants | Invoke |
|---|---|
| Drive a Rust crate/folder/file through the extraction repair loop | fvs:aeneas-extract |
| Model one external Rust stub and its bounded dependency closure in Lean | fvs:model-external |
| Sync the local Aeneas/Charon clones, docs, and reconcile the blocker catalog | fvs:sync-aeneas-verif |

Invoke the matched skill directly using the Skill tool.
