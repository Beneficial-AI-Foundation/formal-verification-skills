---
name: fvs:manage
description: "management | help update checkpoint pause resume patches kb"
argument-hint: ""
allowed-tools:
  - Read
  - Skill
requires: [help, update, checkpoint, pause-work, resume-work, reapply-patches, kb-setup]
---

Route to the appropriate management skill based on the user's intent.

When invoked WITH a request, match it against the table below and invoke the matched skill immediately, forwarding the request. When invoked BARE (no request), print this table as plain text and let the user reply free-form.

| User wants | Invoke |
|---|---|
| Show the FVS command reference | fvs:help |
| Update FVS to the latest version | fvs:update |
| Checkpoint current verification progress | fvs:checkpoint |
| Pause work and write a handoff doc | fvs:pause-work |
| Resume previously paused work | fvs:resume-work |
| Reapply local patches after an update | fvs:reapply-patches |
| Set up a NotebookLM knowledge base | fvs:kb-setup |

Invoke the matched skill directly using the Skill tool.
