---
name: fvs-manage
description: management | help configure update checkpoint pause resume patches kb
---

<pi_package_runtime>
- This skill lives under `pi/skills/<name>/SKILL.md`; the FVS package root is `../../..` relative to its directory.
- Resolve every bundled relative path against the skill directory and pass absolute paths to tool calls and shell commands.
- Agent role instructions live under `../../../agents/`. When a workflow requests Task/subagent dispatch, use an available Pi subagent facility with the matching role instructions. If none is installed, perform the role inline and state that fresh-context separation was unavailable. Exception: a review workflow that requires a fresh reviewer must remain pending or offer its documented fallback; never perform that review inline.
- Use Pi's structured question tool when available; otherwise ask the same question in plain text.
- Never write state into the managed package. Project state belongs under the user's current project (normally `.formalising/`).
</pi_package_runtime>

Route to the appropriate management skill based on the user's intent.

When invoked WITH a request, match it against the table below and invoke the matched skill immediately, forwarding the request. When invoked BARE (no request), print this table as plain text and let the user reply free-form.

| User wants | Invoke |
|---|---|
| Show the FVS command reference | fvs:help |
| Configure subagent models, effort, and review defaults | fvs:configure |
| Update FVS to the latest version | fvs:update |
| Checkpoint current verification progress | fvs:checkpoint |
| Pause work and write a handoff doc | fvs:pause-work |
| Resume previously paused work | fvs:resume-work |
| Reapply local patches after an update | fvs:reapply-patches |
| Set up a NotebookLM knowledge base | fvs:kb-setup |

Invoke the matched skill directly using the Skill tool.
