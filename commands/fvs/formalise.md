---
name: fvs:formalise
description: "paper formalisation | formalise crypto refactor"
argument-hint: ""
allowed-tools:
  - Read
  - Skill
requires: [lean-formalise, lean-refactor]
---

Route to the appropriate paper-formalisation skill based on the user's intent.

When invoked WITH a request, match it against the table below and invoke the matched skill immediately, forwarding the request. When invoked BARE (no request), print this table as plain text and let the user reply free-form.

| User wants | Invoke |
|---|---|
| Formalise a paper/topic into Lean | fvs:lean-formalise |
| Refactor / simplify / decompose a proof | fvs:lean-refactor |

Invoke the matched skill directly using the Skill tool.
