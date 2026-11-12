---
name: fvs:update
description: Update FVS to latest version with changelog display
---

<objective>
Check for FVS updates, install if available, and display what changed.

Provides a better update experience than raw `npx fv-skills-baif` by showing version diff and changelog entries.
</objective>

<process>

<step name="get_installed_version">
Detect whether FVS is installed locally or globally by checking both locations:

```bash
# A local install takes priority, except when the current directory is $HOME itself:
# there ./.claude is the global install.
if [ -f "./.claude/fv-skills/VERSION" ] && [ "$(pwd -P)" != "$(cd "$HOME" && pwd -P)" ]; then
  printf '%s\n' "$(cat "./.claude/fv-skills/VERSION")"
  echo "LOCAL"
elif [ -f "$HOME/.claude/fv-skills/VERSION" ]; then
  printf '%s\n' "$(cat "$HOME/.claude/fv-skills/VERSION")"
  echo "GLOBAL"
else
  echo "UNKNOWN"
fi
```

Parse output:
- If last line is "LOCAL": installed version is first line, use `--local` flag for update
- If last line is "GLOBAL": installed version is first line, use `--global` flag for update
- If "UNKNOWN": the installed version cannot be determined. STOP and explain:

```
## FVS Update

**Installed version:** Unknown

No FVS VERSION file was found for this runtime, so the installed version cannot be compared with
npm. Nothing was changed. Reinstall explicitly with the runtime and scope you use, for example
`npx fv-skills-baif@<version> --claude --global`.
```
</step>

<step name="check_latest_version">
Check npm for latest version:

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
Compare installed vs latest by SemVer precedence, never by string order: a prerelease such as
`3.0.0-rc1` is lower than `3.0.0` but higher than `2.3.12`. Set `INSTALLED` and `LATEST`, then run:

```bash
node -e '
const parse = (v) => { const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v).trim());
  return m && [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? m[4].split(".") : []]; };
const gt = (a, b) => { const x = parse(a), y = parse(b); if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  const p = x[3], q = y[3]; if (!p.length || !q.length) return !p.length && q.length > 0;
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined || q[i] === undefined) return q[i] === undefined;
    if (p[i] === q[i]) continue;
    const pn = /^\d+$/.test(p[i]), qn = /^\d+$/.test(q[i]);
    return pn && qn ? Number(p[i]) > Number(q[i]) : pn !== qn ? qn : p[i] > q[i]; }
  return false; };
const [i, l] = process.argv.slice(1);
console.log(!parse(i) || !parse(l) ? "unknown" : gt(l, i) ? "update" : gt(i, l) ? "ahead" : "current");
' "$INSTALLED" "$LATEST"
```

It prints `update`, `current`, `ahead` or `unknown`. Only `update` continues to the next step.

**If unknown:** a version could not be parsed. STOP and show both values; do not install.

**If current:**
```
## FVS Update

**Installed:** X.Y.Z
**Latest:** X.Y.Z

You're already on the latest version.
```

STOP here if already up to date.

**If ahead:**
```
## FVS Update

**Installed:** X.Y.Z
**Latest:** A.B.C

You're ahead of the latest release (development version?).
```

STOP here if ahead. If the installed version is a prerelease (it contains `-`, such as `3.0.0-rc1`),
also say that `@latest` would downgrade it. Never run `@latest` from a prerelease that is ahead of it.
To move to a newer prerelease, the user runs `npx fv-skills-baif@next` or pins an exact version with
`npx fv-skills-baif@<version>`, adding the same runtime and `--local`/`--global` flags as below.
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
Run the update using the install type detected in step 1. Add the flag of the runtime running this
command (`--claude`, `--opencode`, `--antigravity` or `--codex`): without one the noninteractive
installer defaults to Claude Code, so an update run inside agy would not update the agy plugin.

**If LOCAL install:**
```bash
npx fv-skills-baif@latest --local
```

**If GLOBAL install:**
```bash
npx fv-skills-baif@latest --global
```

Capture output. If install fails, show error and STOP.

Clear the update cache so statusline indicator disappears:

```bash
# Clear update cache across all runtime directories
for dir in .claude .codex .config/opencode .opencode .gemini/config/plugins/fvs .agents/plugins/fvs; do
  rm -f "./$dir/cache/fvs-update-check.json"
  rm -f "$HOME/$dir/cache/fvs-update-check.json"
done
```
</step>

<step name="display_result">
```
FVS >> UPDATED

Previous: {old_version}
Current:  {new_version}

Restart Claude Code to pick up the new commands.
```
</step>

<step name="check_local_patches">
After update completes, check if the installer detected and backed up any locally modified files.

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
- [ ] Installed version read correctly (local-first-then-global)
- [ ] Latest version checked via npm
- [ ] Update skipped if already current
- [ ] Changelog fetched from GitHub and displayed BEFORE update
- [ ] Clean install warning shown
- [ ] User confirmation obtained via AskUserQuestion
- [ ] Installer runs with correct flag (--local or --global)
- [ ] Update cache cleared after success
- [ ] Restart reminder shown
</success_criteria>
