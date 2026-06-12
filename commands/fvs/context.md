---
name: fvs:context
description: "codebase context | map dependencies structure"
argument-hint: ""
allowed-tools:
  - Read
  - Skill
requires: [map-code]
---

Route to the appropriate codebase-context skill based on the user's intent.

When invoked WITH a request, match it against the table below and invoke the matched skill immediately, forwarding the request. When invoked BARE (no request), print this table as plain text and let the user reply free-form.

| User wants | Invoke |
|---|---|
| Map a Rust crate's structure and dependencies | fvs:map-code |

Invoke the matched skill directly using the Skill tool.
