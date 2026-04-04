<purpose>
Orchestrate synchronization of Aeneas upstream documentation into FVS reference files.

Reads the mapping table from fv-skills/upstream/aeneas/_sync-meta.json to determine
which upstream sections map to which FVS reference files, fetches the latest content
from GitHub, computes section-level diffs, and dispatches subagents to propose and
apply updates under user supervision.

Two-phase subagent dispatch:
- fvs-researcher: analyzes diffs, identifies affected sections, recommends merge approach
- fvs-executor: applies approved changes to FVS files (one change at a time)

Output: Updated FVS references, refreshed snapshot, updated _sync-meta.json.
</purpose>

<process>

<step name="check_snapshot_status">
## Step 1: Check Snapshot Status

Read `fv-skills/upstream/aeneas/_sync-meta.json` and validate structure.

**Required fields:**
- `upstream_source` -- GitHub repo (e.g., "AeneasVerif/aeneas")
- `upstream_paths` -- directories to check (e.g., ["documentation/", "documentation/skills/"])
- `snapshot_date` -- ISO date of last sync
- `snapshot_commit` -- SHA of last synced commit
- `mapping` -- array of mapping entries
- `tactic_renames` -- object of old->new tactic name mappings

**Inputs:** _sync-meta.json path
**Outputs:** Parsed metadata, list of unique upstream filenames, current snapshot SHA

**Error handling:**
- File missing: report and exit (FVS installed without upstream snapshot)
- Invalid JSON: report parse error and exit
- Missing required fields: report which fields are missing and exit
</step>

<step name="fetch_upstream">
## Step 2: Fetch Latest Upstream

For each unique upstream filename extracted from the mapping table:

1. Determine full path: `.instructions.md` files live in `documentation/skills/`,
   other `.md` files live in `documentation/`
2. Fetch via `gh api` (primary) or `curl` (fallback) from `AeneasVerif/aeneas` main branch
3. Store in `/tmp/fvs-sync-upstream/`
4. Fetch current HEAD SHA for main branch

**Inputs:** List of unique upstream filenames from mapping
**Outputs:** Fetched files in temp directory, latest commit SHA

**Error handling:**
- GitHub unreachable: report network error, suggest retry, exit gracefully
- Individual file 404: report missing file, continue with remaining files
- Rate limiting: report and suggest using `gh auth login` for higher limits
</step>

<step name="diff_against_snapshot">
## Step 3: Diff Against Snapshot

For each fetched file, compare against stored version in `fv-skills/upstream/aeneas/`:

**Section-level comparison:**
1. Split both versions by `## ` headings into sections
2. Hash each section's content (normalize whitespace)
3. Compare hashes: identify added, removed, and modified sections
4. Build change manifest: `{ file, sections_added[], sections_removed[], sections_modified[] }`

**Inputs:** Fetched files, snapshot files
**Outputs:** Change manifest per file, summary counts

**Error handling:**
- Snapshot file missing (new upstream file): mark as entirely new
- Fetched file empty: skip, report as fetch failure
</step>

<step name="map_changes_to_fvs">
## Step 4: Map Changes to FVS Files

For each changed upstream file, look up mapping entries in `_sync-meta.json`:

```
mapping.filter(entry =>
  entry.upstream === changedFile &&
  entry.merge_strategy !== 'defer'
)
```

Group by FVS target file. For each target, collect:
- All upstream sources that affect it
- Which sections changed in each source
- The merge strategy (enrich vs replace_section)

**Dispatch fvs-researcher** to analyze the diffs and recommend merge approach:
- Which FVS sections need updating
- Whether content should be added, replaced, or merged
- Any potential conflicts between multiple upstream sources affecting the same target

**Inputs:** Change manifest, mapping table
**Outputs:** Grouped change list by FVS target, researcher recommendations

**Error handling:**
- Mapping entry references non-existent FVS file: report, skip entry
- Multiple conflicting strategies for same target section: flag for user decision
</step>

<step name="propose_updates">
## Step 5: Propose Updates

For each affected FVS file, present changes to the user one at a time:

1. Show: upstream source, changed sections, current FVS content, proposed update
2. Apply merge strategy:
   - **enrich**: Integrate new content alongside existing FVS additions. Preserve
     any FVS-specific content not present in upstream.
   - **replace_section**: Replace mapped FVS sections with updated upstream content.
     Warn if FVS had local additions in the replaced section.
3. Ask user: "Apply this change? [yes / skip / edit]"
4. **Dispatch fvs-executor** to apply approved changes (one at a time)

**Inputs:** Grouped changes, researcher recommendations, user decisions
**Outputs:** Applied changes list, skipped changes list

**Error handling:**
- Edit conflict (FVS file changed during sync): re-read and retry
- User aborts mid-sync: save progress, report partial state
</step>

<step name="check_tactic_renames">
## Step 6: Check Tactic Renames

Compare `tactic_renames` table in `_sync-meta.json` against fetched upstream content.

Detection approach:
1. Scan fetched content for tactic-like identifiers (words followed by common tactic
   patterns: `by`, in tactic blocks, after `·`)
2. Compare against known tactic names in `_sync-meta.json` renames table
3. If a tactic name appears in upstream that is NOT in the renames table and differs
   from names used in FVS references, flag as potential rename

For each detected rename:
1. Show: old name, new name, where found
2. Ask user to approve propagation
3. If approved: grep across fv-skills/, commands/, agents/ and apply rename
4. Update `tactic_renames` in `_sync-meta.json`

**Inputs:** Fetched content, current renames table
**Outputs:** New renames applied, updated renames table

**Error handling:**
- False positive detection: user skips, no harm done
- Rename breaks syntax: Lean files are not modified (FVS is markdown-only)
</step>

<step name="update_snapshot">
## Step 7: Update Snapshot

Replace stored snapshot files with fetched versions:

1. Copy each fetched file from `/tmp/fvs-sync-upstream/` to `fv-skills/upstream/aeneas/`
2. Update `_sync-meta.json`:
   - `snapshot_date`: current ISO timestamp
   - `snapshot_commit`: latest commit SHA from Step 2
   - `tactic_renames`: updated if new renames were added in Step 6
3. Clean up `/tmp/fvs-sync-upstream/`

**Inputs:** Fetched files, latest commit SHA, updated renames
**Outputs:** Updated snapshot directory, updated _sync-meta.json

**Error handling:**
- Write failure: report, preserve temp files for manual recovery
</step>

<step name="report">
## Step 8: Report

Summarize the sync operation:

```
FVS >> Sync Complete

Snapshot updated: {old_commit} -> {new_commit}

| Action                        | Count |
|-------------------------------|-------|
| Changes applied               | {N}   |
| Changes skipped               | {M}   |
| Tactic renames propagated     | {K}   |
| Files updated in snapshot     | {F}   |

Run `npm test` to verify no frontmatter or structural issues.
```

If any deferred files had changes, note them:
```
Deferred files with upstream changes (no FVS target assigned):
- {filename}: {N} sections changed
Consider assigning FVS targets in _sync-meta.json for future syncs.
```

**Inputs:** All tracking counters from previous steps
**Outputs:** Final report displayed to user
</step>

</process>

<success_criteria>
- _sync-meta.json read and validated with all required fields
- All mapped upstream files fetched (with graceful fallback)
- Section-level diff computed (not just byte-level)
- Changes correctly mapped to FVS targets via mapping table
- User reviewed and approved/skipped each change individually
- Tactic renames detected and propagated with user approval
- Snapshot files and metadata updated
- Final report shows accurate counts
- No silent failures -- all errors reported to user
</success_criteria>
