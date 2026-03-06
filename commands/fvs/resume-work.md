---
name: fvs:resume-work
description: Resume verification work from previous session
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
  - Write
---

<objective>
Read `.formalising/.continue-here.md` and restore verification context from a previous session. Display formatted state summary and offer to continue from the recorded next action.

This is an explicit user action -- no auto-detection of paused state on session start.
</objective>

<execution_context>
@~/.claude/fv-skills/references/ui-brand.md
</execution_context>

<context>
No arguments needed. Reads `.formalising/.continue-here.md` if it exists.

- Framework-agnostic (no lean- prefix)
- Does NOT auto-detect paused state on session start (locked decision)
- User must explicitly run /fvs:resume-work
</context>

<process>

## Step 1: Find handoff file

```bash
[ -f .formalising/.continue-here.md ] && echo "FOUND" || echo "NOT_FOUND"
```

If not found:
```
FVS >> NO PAUSED WORK

No handoff file found at .formalising/.continue-here.md

To pause your current work: /fvs:pause-work
To start fresh: /fvs:map-code
```
Exit -- do not proceed further.

If found: read the full file content.

## Step 2: Read and display state

Parse all XML-tagged sections from `.formalising/.continue-here.md`. Extract the `last_updated` field from the YAML frontmatter.

Display formatted summary:

```
FVS >> RESUMING WORK

Last paused: {last_updated timestamp}

>> Current State
{current_state section content}

>> Completed
{completed_work section content}

>> Remaining
{remaining_work section content}

>> Decisions
{decisions_made section content}

>> Blockers
{blockers section content}

>> Next Action
{next_action section content}
```

## Step 3: Verify project state

Check whether the project has changed since the pause:

```bash
# Check git status (any new changes since pause?)
git status --short 2>/dev/null

# Check current branch
git branch --show-current 2>/dev/null

# Re-count sorry in spec files
SORRY_NOW=$(grep -r "sorry" --include="*.lean" Specs/ 2>/dev/null | wc -l | tr -d ' ')
echo "Current sorry count: $SORRY_NOW"
```

Compare with handoff file state. If there are new uncommitted changes or the sorry count has changed, note the differences:

```
>> State Changes Since Pause
- Uncommitted files: {list, or "none"}
- Sorry count: {current} (was {recorded at pause time})
```

## Step 4: Offer to continue

Display the ready prompt with the recorded next action:

```
Ready to continue. Your next action:
{next_action from handoff file}
```

Do NOT auto-start any work. Wait for user to confirm or redirect.

</process>

<success_criteria>
- [ ] Handoff file found and parsed (or clear message if missing)
- [ ] All sections displayed with formatted headers
- [ ] Project state re-verified (git status, sorry counts)
- [ ] Changes since pause noted if any
- [ ] Next action presented but not auto-executed
</success_criteria>
