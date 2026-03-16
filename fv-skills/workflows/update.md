<purpose>
Orchestrate self-update of the FVS plugin.

Checks the currently installed version against the latest published npm version,
fetches and displays changelog entries for what changed, obtains user confirmation,
and runs the installer to update if a newer version is available.

Output: Updated FVS installation with changelog display, or confirmation that the current version is latest.
</purpose>

<process>

<step name="check_current_version">
Detect whether FVS is installed locally or globally by checking both locations:

```bash
# Check local first (takes priority), with path canonicalization
# to prevent misdetection when CWD=$HOME
LOCAL_DIR="" GLOBAL_DIR=""
if [ -f "./.claude/fv-skills/VERSION" ]; then
  LOCAL_DIR="$(cd ./.claude 2>/dev/null && pwd)"
fi
if [ -f "$HOME/.claude/fv-skills/VERSION" ]; then
  GLOBAL_DIR="$(cd "$HOME/.claude" 2>/dev/null && pwd)"
fi

# Only treat as LOCAL if resolved paths differ (handles CWD=$HOME edge case)
if [ -n "$LOCAL_DIR" ] && { [ -z "$GLOBAL_DIR" ] || [ "$LOCAL_DIR" != "$GLOBAL_DIR" ]; }; then
  INSTALLED=$(cat "./.claude/fv-skills/VERSION")
  echo "$INSTALLED"
  echo "LOCAL"
elif [ -n "$GLOBAL_DIR" ]; then
  INSTALLED=$(cat "$HOME/.claude/fv-skills/VERSION")
  echo "$INSTALLED"
  echo "GLOBAL"
else
  echo "UNKNOWN"
fi
```

Parse output:
- If last line is "LOCAL": installed version is first line, use `--local` flag for update
- If last line is "GLOBAL": installed version is first line, use `--global` flag for update
- If "UNKNOWN": proceed to install step (treat as version 0.0.0)

**If VERSION file missing:**
```
## FVS Update

**Installed version:** Unknown

Your installation doesn't include version tracking.

Running fresh install...
```

Proceed to install step (treat as version 0.0.0 for comparison).
</step>

<step name="check_available_version">
Query npm for the latest published version.

```bash
npm view fv-skills-baif version 2>/dev/null
```

**If npm check fails:**
```
Couldn't check for updates (offline or npm unavailable).

To update manually: `npx fv-skills-baif --global`
```

STOP here if npm unavailable.
</step>

<step name="compare_versions">
Compare installed vs latest:

**If installed == latest:**
```
## FVS Update

**Installed:** X.Y.Z
**Latest:** X.Y.Z

You're already on the latest version.
```

STOP here if already up to date.

**If installed > latest:**
```
## FVS Update

**Installed:** X.Y.Z
**Latest:** A.B.C

You're ahead of the latest release (development version?).
```

STOP here if ahead.
</step>

<step name="show_changes_and_confirm">
**If update available**, fetch and show what's new BEFORE updating:

1. Fetch changelog from GitHub:

```bash
CHANGELOG=$(curl -sL "https://raw.githubusercontent.com/Beneficial-AI-Foundation/formal-verification-skills/main/CHANGELOG.md")
```

2. Extract entries between installed and latest versions:

```bash
# CHANGELOG uses headers like: ## [1.1.0] - 2026-03-09
# Extract everything from latest version header up to (but excluding) installed version header
echo "$CHANGELOG" | sed -n "/^## \[${LATEST}\]/,/^## \[${INSTALLED}\]/p" | sed '$d'
```

3. If curl fails or extraction is empty, use fallback:

```
Changelog not available -- see GitHub releases for details.
```

4. Display preview and ask for confirmation:

```
## FVS Update Available

**Installed:** 1.0.0
**Latest:** 1.1.0

### What's New
────────────────────────────────────────────────────────────

{extracted changelog entries, or fallback message}

────────────────────────────────────────────────────────────

The installer performs a clean install of FVS folders:
- commands/fvs/ will be wiped and replaced
- fv-skills/ will be wiped and replaced
- agents/fvs-* files will be replaced

(Paths are relative to your install location: ~/.claude/ for global, ./.claude/ for local)

Your custom files are preserved:
- Custom commands not in commands/fvs/ ✓
- Custom agents not prefixed with fvs- ✓
- Your CLAUDE.md files ✓

If you've modified any FVS files directly, they'll be automatically backed up to `fvs-local-patches/` and can be reapplied with `/fvs:reapply-patches` after the update.
```

Use AskUserQuestion:
- Question: "Proceed with update?"
- Options:
  - "Yes, update now"
  - "No, cancel"

**If user cancels:** STOP here.
</step>

<step name="run_update">
Run the update using the install type detected in step 1:

**If LOCAL install:**
```bash
npx fv-skills-baif@latest --local
```

**If GLOBAL install (or unknown):**
```bash
npx fv-skills-baif@latest --global
```

Capture output. If install fails, show error and STOP.

Clear the update cache so statusline indicator disappears:

```bash
# Clear update cache across all runtime directories
for dir in .claude .config/opencode .opencode .gemini; do
  rm -f "./$dir/cache/fvs-update-check.json"
  rm -f "$HOME/$dir/cache/fvs-update-check.json"
done
```
</step>

<step name="verify_update">
Confirm the update succeeded using local-first detection:

```bash
if [ -f "./.claude/fv-skills/VERSION" ]; then
  cat "./.claude/fv-skills/VERSION"
elif [ -f "$HOME/.claude/fv-skills/VERSION" ]; then
  cat "$HOME/.claude/fv-skills/VERSION"
fi
```

**Report result:**
```
FVS >> UPDATED

Previous: {old_version}
Current:  {new_version}

Restart Claude Code to pick up the new commands.
```
</step>

<step name="check_local_patches">
After update completes, check if the installer detected and backed up any locally modified files:

Check for fvs-local-patches/backup-meta.json in the config directory.

**If patches found:**

```
Local patches were backed up before the update.
Run /fvs:reapply-patches to merge your modifications into the new version.
```

**If no patches:** Continue normally.
</step>

</process>

<success_criteria>
- Installed version read correctly (local-first-then-global)
- Latest version checked via npm registry
- Update skipped if already current
- Changelog fetched from GitHub and displayed BEFORE update
- Clean install warning shown
- User confirmation obtained via AskUserQuestion
- Installer runs with correct flag (--local or --global)
- Update cache cleared after success
- Restart reminder shown
</success_criteria>
