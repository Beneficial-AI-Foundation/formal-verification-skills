---
name: fvs:aeneas
description: "aeneas extraction | extract repair-loop pins sync"
argument-hint: ""
allowed-tools:
  - Read
  - Skill
requires: [aeneas-extract, sync-aeneas-verif]
---

Route to the appropriate aeneas-extraction skill based on the user's intent.

When invoked WITH a request, match it against the table below and invoke the matched skill immediately, forwarding the request. When invoked BARE (no request), print this table as plain text and let the user reply free-form.

| User wants | Invoke |
|---|---|
| Drive a Rust crate/folder/file through the extraction repair loop | fvs:aeneas-extract |
| Sync the local Aeneas/Charon clones, docs, and reconcile the blocker catalog | fvs:sync-aeneas-verif |

Invoke the matched skill directly using the Skill tool.
