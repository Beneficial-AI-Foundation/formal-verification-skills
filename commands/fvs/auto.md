---
name: fvs:auto
description: "auto track | init extract top-specs execute"
argument-hint: ""
allowed-tools:
  - Read
  - Bash
  - Skill
requires: [auto-init, auto-extract, auto-top-specs, auto-execute]
---

Route to the appropriate auto-track skill based on the user's intent.

When invoked WITH a request, match it against the table below and invoke the matched skill immediately, forwarding the request. When invoked BARE (no request), first report the recorded state, then print this table as plain text and let the user reply free-form.

To report the state, run `node ~/.claude/scripts/fvs-auto.mjs read-state --project-root .` and print three lines from its JSON result:

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
