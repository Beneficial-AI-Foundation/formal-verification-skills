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

Read `backup-meta.json` from the patches directory. For version 2, resolve its `bundle`
relative to that directory (strictly `bundles/bundle-<id>`). This immutable bundle is
the source for the file copies below. Legacy metadata refers to the flat directory.
Check canonical paths remain inside the selected installation and reject symlinks.

Before merging, enumerate every file in the bundle, excluding its `backup-meta.json`.
Compare the enumeration with `files` and verify `hashes` when present. Report every
unlisted file and every missing or changed entry; never silently omit them. Stop for
user inspection on missing/changed entries. Offer unlisted legacy files for recovery.
Older immutable bundles and legacy flat copies remain available for inspection.

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

For each file in `backup-meta.json`:

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

## Step 4: Update manifest

After reapplying, note that the manifest will be regenerated on the next `/fvs:update`:

```bash
# The manifest will be regenerated on next /fvs:update
# For now, just note which files were modified
```

## Step 5: Cleanup option

Ask user:
- "Keep patch backups for reference?" -- preserve `fvs-local-patches/`
- "Clean up selected patch bundle?" -- name the exact bundle; delete it only after
  explicit approval, without deleting older bundles or dangling the active pointer.

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
- [ ] All backed-up patches processed
- [ ] User modifications merged into new version
- [ ] Conflicts resolved with user input
- [ ] Status reported for each file
</success_criteria>
