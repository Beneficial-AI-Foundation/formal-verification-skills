---
name: fvs-update
description: Update the installed FVS Pi package to its latest npm release
---

<pi_package_runtime>
- This skill lives under `pi/skills/<name>/SKILL.md`; the FVS package root is `../../..` relative to its directory.
- Resolve every bundled relative path against the skill directory and pass absolute paths to tool calls and shell commands.
- Agent role instructions live under `../../../agents/`. When a workflow requests Task/subagent dispatch, use an available Pi subagent facility with the matching role instructions. If none is installed, perform the role inline and state that fresh-context separation was unavailable. Exception: a review workflow that requires a fresh reviewer must remain pending or offer its documented fallback; never perform that review inline.
- Use Pi's structured question tool when available; otherwise ask the same question in plain text.
- Never write state into the managed package. Project state belongs under the user's current project (normally `.formalising/`).
</pi_package_runtime>

<objective>
Update the managed FVS Pi package without modifying its installed files directly.
</objective>

<process>
1. Read the installed version from `../../../fv-skills/VERSION`, resolving it against this skill directory.
2. Run `npm view fv-skills-baif version` and report whether an update is available.
3. If an update is available, summarize its changelog entry and ask for confirmation.
4. On confirmation, run `pi update npm:fv-skills-baif`.
5. Report the result and ask the user to run `/reload` or start a new Pi session.
</process>
