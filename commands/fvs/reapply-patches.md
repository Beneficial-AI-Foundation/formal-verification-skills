---
name: fvs:reapply-patches
description: Reapply local modifications after an FVS update
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion
---

<purpose>
After an FVS update wipes and reinstalls files, this command merges user's previously saved local modifications back into the new version. Uses intelligent comparison to handle cases where the upstream file also changed.
</purpose>

<process>

## Step 1: Detect backed-up patches

Use the active installation's runtime and scope, including `.codex` for Codex.
Prefer that exact config directory; if multiple installations have patches, ask which
one to restore instead of taking the first global match.

Resolve `PATCHES_DIR` as `fvs-local-patches/` beside the active installation
manifest. For local installs this is under the project runtime directory; for
global installs use that runtime’s configured root (including custom config roots).
Do not search unrelated runtimes or prefer a global backup over the active local one.

Read `backup-meta.json` from the patches directory. For version 2 or 3, resolve its `bundle`
relative to that directory (strictly `bundles/bundle-<id>`). This immutable bundle is the source
for file copies below. Version 3 uses `pending` as the active reapply set and keeps `files` as the
historical bundle inventory; version 2 treats every `files` entry as pending. Legacy metadata refers
to the flat directory.
Check canonical paths remain inside the selected installation and reject symlinks.

Before merging, enumerate every file in the bundle, excluding its `backup-meta.json`. Compare the
enumeration with historical `files` and verify `hashes` when present. Report every unlisted file and
every missing or changed entry; never silently omit them. Stop for user inspection on
missing/changed entries. Offer unlisted legacy files for recovery. Process only `pending` (or
version-2 `files`) as active patches. Older immutable bundles and resolved entries remain available
for inspection without being copied into the next active set.

**If no patches found:**
```
No local patches found. Nothing to reapply.

Local patches are automatically saved when you run /fvs:update
after modifying any FVS workflow, command, or agent files.
```
Exit.

## Step 2: Show patch summary

```
## Local Patches to Reapply

**Backed up from:** v{from_version}
**Current version:** {read fv-skills/VERSION file}
**Files modified:** {count}

| # | File | Status |
|---|------|--------|
| 1 | {file_path} | Pending |
| 2 | {file_path} | Pending |
```

## Step 3: Merge each file

For each active file in `pending` (or version-2 `files`):

1. **Read the backed-up version** (user's modified copy from `fvs-local-patches/`)
2. **Read the newly installed version** (current file after update)
3. **Compare and merge:**

   - If the new file is identical to the backed-up file: skip (modification was incorporated upstream)
   - If the new file differs: identify the user's modifications and apply them to the new version
   - If `kinds[path]` is `added` and no upstream file exists, restore the local addition
     at that path, including its companion files. For modified/legacy missing paths
     (such as renamed or removed commands), report manual placement instead of
     resurrecting an obsolete upstream command.

   **Merge strategy:**
   - Read both versions fully
   - Identify sections the user added or modified (look for additions, not just differences from path replacement)
   - Apply user's additions/modifications to the new version
   - If a section the user modified was also changed upstream: flag as conflict, show both versions, ask user which to keep
   - Legacy backups have no original upstream contents; two different versions alone
     cannot identify which edits were local. Surface ambiguity instead of guessing.
   - Codex `.toml` agent mirrors are backed up separately. Reconcile both the `.md`
     instructions and `.toml` mirror; do not discard custom TOML settings or leave
     the runtime pointing at stale instructions.

4. **Write merged result** to the installed location
5. **Report status:**
   - `Merged` -- user modifications applied cleanly
   - `Skipped` -- modification already in upstream
   - `Conflict` -- user chose resolution

## Step 4: Retire processed active entries

After each file reaches a final outcome (`Merged`, `Skipped (already upstream)`, or an explicit
choice to keep the new upstream file), atomically rewrite the top-level `backup-meta.json` as
version 3 with that path removed from `pending`. Preserve `bundle`, historical `files`, `hashes`,
`kinds`, and the immutable bundle contents. A conflict the user defers remains pending.

When `pending` becomes empty, keep the pointer with `pending: []` so the selected bundle remains
historical evidence. The next update must not reactivate or copy those resolved entries. A newly
modified installed file will still be detected independently against `fvs-file-manifest.json`.

## Step 5: Cleanup option

Ask user:
- "Keep patch backups for reference?" -- preserve `fvs-local-patches/`; this never keeps resolved
  entries active.
- "Clean up selected patch bundle?" -- only when its `pending` set is empty; name the exact bundle
  and delete it after explicit approval without deleting older bundles or dangling the pointer.

## Step 6: Report

```
## Patches Reapplied

| # | File | Status |
|---|------|--------|
| 1 | {file_path} | Merged |
| 2 | {file_path} | Skipped (already upstream) |
| 3 | {file_path} | Conflict resolved |

{count} file(s) updated. Your local modifications are active again.
```

</process>

<success_criteria>
- [ ] Every active pending patch processed or explicitly left pending
- [ ] User modifications merged into the new version
- [ ] Resolved/upstream-chosen entries removed from `pending` without deleting historical bundles
- [ ] Conflicts resolved with user input or kept pending
- [ ] Status reported for each file
</success_criteria>
