---
name: fvs:sync-aeneas
description: Sync Aeneas upstream documentation and update FVS references
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion
---

<purpose>
Fetch latest Aeneas documentation from GitHub, diff against the stored snapshot,
and propose updates to FVS references using the mapping table in _sync-meta.json.

The user reviews and approves each proposed change individually. This keeps FVS
aligned with upstream Aeneas evolution without silent overwrites.

Upstream source: AeneasVerif/aeneas (documentation/ and documentation/skills/)
Mapping table: fv-skills/upstream/aeneas/_sync-meta.json
</purpose>

<process>

## Step 1: Read current snapshot status

Read the sync metadata to understand what we have:

```bash
SYNC_META="fv-skills/upstream/aeneas/_sync-meta.json"
[ -f "$SYNC_META" ] && echo "Metadata found" || echo "ERROR: _sync-meta.json not found"
```

Parse `_sync-meta.json` and display current state:

```
FVS >> Aeneas Sync Status

Snapshot date:    {snapshot_date}
Snapshot commit:  {snapshot_commit} (first 12 chars)
Mapped files:     {count of unique upstream filenames in mapping}
Upstream source:  AeneasVerif/aeneas
```

**If _sync-meta.json is missing:**
```
FVS >> ERROR: No sync metadata found

Expected: fv-skills/upstream/aeneas/_sync-meta.json

This file is created during FVS installation. If you installed without
the upstream snapshot, run the installer again with the Aeneas option.
```
Stop.

## Step 2: Fetch latest upstream

For each unique upstream file in `_sync-meta.json` mapping entries:

```bash
# Create temp directory for fetched files
mkdir -p /tmp/fvs-sync-upstream

# Determine upstream path -- skills/ files vs documentation/ files
# Files ending in .instructions.md are in documentation/skills/
# Other .md files are in documentation/

for FILENAME in {unique upstream filenames from mapping}; do
  if echo "$FILENAME" | grep -q '\.instructions\.md$'; then
    UPSTREAM_PATH="documentation/skills/$FILENAME"
  else
    UPSTREAM_PATH="documentation/$FILENAME"
  fi

  # Primary: gh CLI
  gh api "repos/AeneasVerif/aeneas/contents/$UPSTREAM_PATH" --jq '.content' \
    | base64 -d > "/tmp/fvs-sync-upstream/$FILENAME" 2>/dev/null

  # Fallback: curl
  if [ ! -s "/tmp/fvs-sync-upstream/$FILENAME" ]; then
    curl -sL "https://raw.githubusercontent.com/AeneasVerif/aeneas/main/$UPSTREAM_PATH" \
      > "/tmp/fvs-sync-upstream/$FILENAME"
  fi
done

# Get current HEAD SHA
LATEST_COMMIT=$(gh api repos/AeneasVerif/aeneas/commits/main --jq '.sha')
echo "Latest upstream commit: $LATEST_COMMIT"
```

Report fetch results:

```
FVS >> Fetched {N} upstream files

Latest commit: {LATEST_COMMIT} (first 12 chars)
Your snapshot:  {snapshot_commit} (first 12 chars)
Commits behind: (compare SHAs -- if different, upstream has changed)
```

**If GitHub is unreachable:** Report error and suggest checking network. Stop.

## Step 3: Diff against snapshot

For each fetched file, compare against the stored snapshot:

```bash
# For each upstream file
diff "fv-skills/upstream/aeneas/$FILENAME" "/tmp/fvs-sync-upstream/$FILENAME"
```

Use section-level comparison for meaningful change detection:
- Split each file by `## ` headings
- Hash each section's content (ignoring leading/trailing whitespace)
- Compare section hashes between snapshot and fetched version
- Track: sections added, sections removed, sections modified

Report:

```
FVS >> Diff Summary

| File | Status | Sections Changed |
|------|--------|-----------------|
| {filename} | Changed | {N} sections modified, {M} added |
| {filename} | Unchanged | -- |
| {filename} | New | (not in snapshot) |

Total: {N} files changed, {M} files unchanged, {K} new/removed
```

**If no changes:** Report "Snapshot is up to date. No sync needed." Stop.

## Step 4: Map changes to FVS files

For each changed upstream file, look up the mapping entries in `_sync-meta.json`:

```javascript
// For each changed file, find all mapping entries where upstream matches
mapping.filter(entry => entry.upstream === changedFile && entry.merge_strategy !== 'defer')
```

Group changes by FVS target file:

```
FVS >> Affected FVS Files

| FVS Target | Upstream Source(s) | Sections Affected | Strategy |
|------------|-------------------|-------------------|----------|
| fv-skills/references/aeneas-patterns.md | aeneas-lean-core, tips-and-tricks | 4 sections | enrich |
| fv-skills/references/tactic-usage.md | aeneas-tactics-quickref | 2 sections | replace_section |
```

**Deferred entries** (merge_strategy: "defer") are listed separately:
```
Deferred (no FVS target assigned):
- agent-fleet-management.instructions.md
- launching-proof-agents.instructions.md
```

## Step 5: Propose updates

For each affected FVS file (grouped by target):

1. **Read the current FVS file** and the relevant upstream sections
2. **Show the diff** between old and new upstream content for each mapped section
3. **Generate proposed update** based on merge strategy:
   - `enrich`: Add new content alongside existing. Preserve FVS additions.
   - `replace_section`: Replace the mapped FVS sections with updated upstream content.
   - `defer`: Skip (no FVS target).
4. **Present to user:**

```
FVS >> Proposed Change {N}/{TOTAL}

Target: {fvs_target}
Source: {upstream filename} -> {upstream_sections}
Strategy: {merge_strategy}

--- Current FVS content (relevant section) ---
{current content excerpt}

--- Proposed update ---
{proposed content}

Apply this change? [yes / skip / edit]
```

- **yes**: Apply the proposed change via Edit tool
- **skip**: Skip this change, move to next
- **edit**: Open the file for manual editing. Wait for user to indicate they are done.

## Step 6: Check for tactic renames

Read the `tactic_renames` table from `_sync-meta.json`:

```json
{
  "progress": "step",
  "progress*": "step*",
  "progress?": "step*?",
  "@[progress]": "@[step]",
  "progress_simps": "step_simps"
}
```

Scan the fetched upstream content for tactic names that:
- Do not appear in the current renames table
- Differ from patterns used in FVS references

If new potential renames detected:

```
FVS >> Potential Tactic Rename Detected

Old name: {old_tactic}
New name: {new_tactic}
Found in: {upstream_file}, section: {section_name}

Propagate this rename across FVS content? [yes / skip]
```

If user approves, use Grep to find all occurrences and Edit to update:

```bash
# Find occurrences
grep -rn "{old_tactic}" fv-skills/ commands/ agents/
```

Apply renames and add to `tactic_renames` in `_sync-meta.json`.

## Step 7: Update snapshot

After all changes are processed (applied or skipped):

1. **Replace snapshot files** with fetched versions:
```bash
cp /tmp/fvs-sync-upstream/* fv-skills/upstream/aeneas/
```

2. **Update _sync-meta.json** metadata:
```javascript
// Update snapshot fields
meta.snapshot_date = new Date().toISOString();
meta.snapshot_commit = LATEST_COMMIT;
// If tactic_renames were added, they are already updated
```

3. **Clean up temp files:**
```bash
rm -rf /tmp/fvs-sync-upstream
```

## Step 8: Report

```
FVS >> Sync Complete

Snapshot updated: {old_commit} -> {new_commit}

| Action | Count |
|--------|-------|
| Changes applied | {N} |
| Changes skipped | {M} |
| Tactic renames propagated | {K} |
| Files updated in snapshot | {F} |

Run `npm test` to verify no frontmatter or structural issues.
```

</process>

<success_criteria>
- [ ] _sync-meta.json read and validated
- [ ] All mapped upstream files fetched from GitHub
- [ ] Section-level diff computed and reported
- [ ] Changes mapped to FVS target files via mapping table
- [ ] User approved/skipped each proposed change
- [ ] Tactic renames checked and propagated if found
- [ ] Snapshot files updated to latest upstream
- [ ] _sync-meta.json snapshot_date and snapshot_commit updated
</success_criteria>
