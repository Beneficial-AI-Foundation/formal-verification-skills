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

To report the state, run `node "$HOME/.claude/scripts/fvs-auto.mjs" read-state --project-root .` and print three lines from its JSON result:

```
State:            {recorded choices and extraction status, or the result's message when there is no state or it is malformed}
Next action:      {nextAction, or the result's nextStep when the state is malformed}
Pending decision: {pendingDecisions, or none}
```

The pipeline: `auto-init` records the agreement, `auto-extract` extracts the recorded revision,
`auto-top-specs` writes and reviews the statements and opens the spec pull request as a draft, and
after the owner merges it `auto-execute` proves them and opens the proof pull request as a draft.

| User wants | Invoke |
|---|---|
| Check the host and record the source revision, scope and agreement | fvs:auto-init |
| Extract the recorded revision and record its externals | fvs:auto-extract |
| Write and review the Lean statements for the agreed scope, then open the draft spec pull request | fvs:auto-top-specs |
| Prove the merged statements, check them in a fresh clean copy and open the draft proof pull request | fvs:auto-execute |

Agents may open draft pull requests and edit a pull request body. They never post comments or reviews
on GitHub, never mark a pull request ready and never merge: only the owner comments, marks ready and
merges.

Invoke the matched skill directly using the Skill tool.
