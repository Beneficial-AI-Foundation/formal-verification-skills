<purpose>
Orchestrate self-update of the FVS plugin.

Checks the currently installed version against the latest published npm version,
shows a comparison, and runs the installer to update if a newer version is available.

Output: Updated FVS installation or confirmation that the current version is latest.
</purpose>

<process>

<step name="check_current_version">
Read the installed VERSION file.

```bash
cat ~/.claude/fv-skills/VERSION 2>/dev/null || cat .claude/fv-skills/VERSION 2>/dev/null
```

If VERSION file not found, FVS may not be installed or is installed from source.
Report the issue and suggest reinstalling:
```
FVS >> VERSION FILE NOT FOUND

Cannot determine installed version.
Run: npx fv-skills-baif to install or reinstall.
```
</step>

<step name="check_available_version">
Query npm for the latest published version.

```bash
npm view fv-skills-baif version 2>/dev/null
```

If npm is unreachable or the package is not published yet, report:
```
FVS >> CANNOT CHECK UPDATES

npm registry unreachable or package not yet published.
Current version: {current}
```
</step>

<step name="compare_versions">
Compare current and available versions.

**If current >= available:**
```
FVS >> UP TO DATE

Installed: {current}
Latest:    {available}

No update needed.
```
Stop here.

**If available > current:**
```
FVS >> UPDATE AVAILABLE

Installed: {current}
Latest:    {available}

Proceed with update? (yes/no)
```

Wait for user confirmation before proceeding.
</step>

<step name="run_update">
Run the installer to update.

```bash
npx fv-skills-baif
```

The installer handles:
- Clean wipe of all fvs-owned files (fvs-* prefix)
- Fresh copy of all content files
- settings.json merge (additive hooks, statusline conflict detection)
</step>

<step name="verify_update">
Confirm the update succeeded.

```bash
cat ~/.claude/fv-skills/VERSION 2>/dev/null || cat .claude/fv-skills/VERSION 2>/dev/null
```

**Report result:**
```
FVS >> UPDATED

Previous: {old_version}
Current:  {new_version}

Update complete.
```
</step>

</process>

<success_criteria>
- Current version read from installed VERSION file
- Latest version checked via npm registry
- Version comparison displayed clearly
- User confirms before update proceeds
- Installer runs and completes without error
- New version confirmed after update
</success_criteria>
