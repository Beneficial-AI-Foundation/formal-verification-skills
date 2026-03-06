---
name: fvs:pause-work
description: Create context handoff when pausing verification work
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - Grep
---

<objective>
Create `.formalising/.continue-here.md` handoff file preserving complete verification work state across sessions. Simpler than GSD -- no STATE.md or gsd-tools dependency. Self-contained command with inline process.

Output: `.formalising/.continue-here.md` with XML-tagged context sections.
</objective>

<execution_context>
@~/.claude/fv-skills/references/ui-brand.md
</execution_context>

<context>
No arguments needed. Works in any project with a `.formalising/` directory.

- Check for `.formalising/CODEMAP.md` for verification project context
- Check for `.formalising/.continue-here.md` for existing paused state
- Framework-agnostic (no lean- prefix)
</context>

<process>

## Step 1: Gather current state

Read existing project context:

```bash
# Check for CODEMAP (verification project context)
[ -f .formalising/CODEMAP.md ] && echo "[OK] CODEMAP found" || echo "[--] No CODEMAP"

# Check for existing handoff file
[ -f .formalising/.continue-here.md ] && echo "[!!] Existing handoff found -- will overwrite" || echo "[OK] No existing handoff"

# Check git status for uncommitted changes
git status --short 2>/dev/null

# Check current branch
git branch --show-current 2>/dev/null
```

Count remaining sorry in spec files (if any):

```bash
SORRY_FILES=$(grep -rl "sorry" --include="*.lean" Specs/ 2>/dev/null | wc -l | tr -d ' ')
SORRY_TOTAL=$(grep -r "sorry" --include="*.lean" Specs/ 2>/dev/null | wc -l | tr -d ' ')
echo "Spec files with sorry: $SORRY_FILES"
echo "Total sorry count: $SORRY_TOTAL"
```

If CODEMAP.md exists, read it for function inventory and verification status summary.

## Step 2: Ask user for context

Ask the user these questions conversationally:

1. **"What were you working on?"** (current function, module, or proof)
2. **"What's left to do?"** (remaining work summary)
3. **"Any blockers or notes for next session?"**

Wait for user responses before proceeding.

## Step 3: Write handoff file

```bash
mkdir -p .formalising
```

Write `.formalising/.continue-here.md` using the Write tool (VS Code diff) with this structure:

```markdown
---
status: paused
last_updated: {ISO timestamp}
---

<current_state>
{user's description of current work}
</current_state>

<completed_work>
{auto-detected from git log and spec files}
- Recent commits: {last 5 commit messages from git log --oneline -5}
- Verified specs: {count of sorry-free spec files}
- In-progress specs: {count of spec files with sorry}
</completed_work>

<remaining_work>
{user's description of remaining work}
- Spec files with sorry: {count}
- Total sorry remaining: {count}
</remaining_work>

<decisions_made>
{any decisions from the session, or "None noted"}
</decisions_made>

<blockers>
{user-provided blockers, or "None"}
</blockers>

<context>
- CODEMAP: {exists/missing}
- Branch: {current git branch}
- Uncommitted files: {list from git status}
</context>

<next_action>
{what to do first when resuming, based on user input}
</next_action>
```

## Step 4: Git commit as WIP

Stage and commit the handoff file:

```bash
git add .formalising/.continue-here.md
git commit -m "wip: paused at {brief description from user's current work}"
```

If the commit fails (nothing to commit, etc.), warn but do not block.

## Step 5: Display confirmation

```
FVS >> WORK PAUSED

Handoff: .formalising/.continue-here.md
Resume:  /fvs:resume-work
```

</process>

<success_criteria>
- [ ] `.formalising/.continue-here.md` created with all XML-tagged sections
- [ ] User's current work context captured
- [ ] Auto-detected state included (git, sorry counts, CODEMAP)
- [ ] Committed as WIP
- [ ] User knows how to resume
</success_criteria>
