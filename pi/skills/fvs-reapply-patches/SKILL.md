---
name: fvs-reapply-patches
description: Explain how to preserve FVS customizations when using the managed Pi package
---

<pi_package_runtime>
- This skill lives under `pi/skills/<name>/SKILL.md`; the FVS package root is `../../..` relative to its directory.
- Resolve every bundled relative path against the skill directory and pass absolute paths to tool calls and shell commands.
- Agent role instructions live under `../../../agents/`. When a workflow requests Task/subagent dispatch, use an available Pi subagent facility with the matching role instructions. If none is installed, perform the role inline and state that fresh-context separation was unavailable. Exception: a review workflow that requires a fresh reviewer must remain pending or offer its documented fallback; never perform that review inline.
- Use Pi's structured question tool when available; otherwise ask the same question in plain text.
- Never write state into the managed package. Project state belongs under the user's current project (normally `.formalising/`).
</pi_package_runtime>

<objective>
Keep the managed Pi package immutable and direct custom FVS changes into a maintained fork or a project-local skill override.
</objective>

<process>
The npm installer's `fvs-local-patches` workflow does not apply to a managed Pi package. Never edit files in Pi's package cache.

If the user needs a persistent customization:

1. Fork `Beneficial-AI-Foundation/formal-verification-skills`.
2. Make and test the change in the canonical source files.
3. Install the fork with `pi install git:github.com/<owner>/formal-verification-skills@<ref>`, or keep a narrowly scoped project-local skill override.
4. Run `/reload` or start a new Pi session.
</process>
