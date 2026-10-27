---
name: fvs-auto
description: auto track | init extract top-specs execute
---

<pi_package_runtime>
- This skill lives under `pi/skills/<name>/SKILL.md`; the FVS package root is `../../..` relative to its directory.
- Resolve every bundled relative path against the skill directory and pass absolute paths to tool calls and shell commands.
- Agent role instructions live under `../../../agents/`. When a workflow requests Task/subagent dispatch, use an available Pi subagent facility with the matching role instructions. If none is installed, perform the role inline and state that fresh-context separation was unavailable. Exception: a review workflow that requires a fresh reviewer must remain pending or offer its documented fallback; never perform that review inline.
- Use Pi's structured question tool when available; otherwise ask the same question in plain text.
- Never write state into the managed package. Project state belongs under the user's current project (normally `.formalising/`).
</pi_package_runtime>

Route to the appropriate auto-track skill based on the user's intent.

When invoked WITH a request, match it against the table below and invoke the matched skill immediately, forwarding the request. When invoked BARE (no request), first report the recorded state, then print this table as plain text and let the user reply free-form.

To report the state, run `node ../../../scripts/fvs-auto.mjs read-state --project-root .` and print three lines from its JSON result:

```
State:            {recorded choices and extraction status, or the result's message when there is no state or it is malformed}
Next action:      {nextAction, or the result's nextStep when the state is malformed}
Pending decision: {pendingDecisions, or none}
```

| User wants | Invoke |
|---|---|
| Check the host and record the source revision, scope and limits | fvs:auto-init |
| Extract the recorded revision and record its externals | fvs:auto-extract |
| Select roots and freeze top-level specifications (milestone 2, not yet available) | fvs:auto-top-specs |
| Dispatch and accept proof work (milestone 2, not yet available) | fvs:auto-execute |

Invoke the matched skill directly using the Skill tool.
