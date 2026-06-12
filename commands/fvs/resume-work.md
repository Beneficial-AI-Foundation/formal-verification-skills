---
name: fvs:resume-work
description: Resume verification from saved handoff context
argument-hint: "[path]"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
---

<objective>
Restore verification context from `.formalising/fv-plans/.continue-here.md` and prepare to continue work. Loads the handoff, reads the target files, and presents the state so work can resume immediately.
</objective>

<process>

## Step 1: Discover Handoff

**If an explicit path argument is given** (`$ARGUMENTS`), resolve it with the same rule as `/fvs:pause-work`: a token ending in `.md` is the exact handoff file; an otherwise path-like token (contains `/`) means `<token>/.continue-here.md`. Load that file directly.

**If bare** (no argument), run the union discovery scan:

```bash
# 1. Glob the legacy + per-topic default handoff locations
find .formalising/fv-plans -name '.continue-here.md' 2>/dev/null

# 2. Grep for the discovery marker to catch custom-named handoffs (e.g. security-handoff.md)
grep -rl '^fvs_handoff: true' .formalising/fv-plans 2>/dev/null
```

Union the two result sets and dedupe (a `.continue-here.md` that also carries the marker is one handoff, not two). Then:

- **No handoffs found:** inform the user and suggest `/fvs:fc-plan` to pick a new target.
- **Exactly one handoff:** load it directly.
- **Multiple handoffs:** sort by `last_updated` frontmatter (most recent first; fall back to file mtime when absent) and present a recency-sorted plain-text NUMBERED list for the user to pick from. Do NOT use AskUserQuestion — a plain numbered list keeps the picker runtime-neutral.

Read the selected handoff file fully.

## Step 2: Verify Branch

```bash
git branch --show-current
git diff --stat HEAD
```

Check if we're on the expected branch. Warn if not.

## Step 3: Load Target Files

Read the target spec/proof file(s) mentioned in the handoff, focusing on:
- The proof gap locations
- Surrounding proof context (50 lines before/after each gap)
- Any helper lemmas or definitions referenced

## Step 4: Load Key References

Read any definition files mentioned in the handoff (e.g., spec definitions, math libraries, constant specs).

## Step 5: Present Resumption Context

```
FVS >> RESUMING

Target:  [file]
Branch:  [branch]
Status:  [status]
Proof gaps: [count] remaining

## State
[Current state summary from handoff]

## Blockers
[Any blockers from handoff]

## Next Action
[The next action from handoff]

Ready to continue. What would you like to do?
```

## Step 6: Cleanup

The handoff file stays for reference. It will be overwritten on the next `/fvs:pause-work`.

</process>

<success_criteria>
- [ ] Handoff file found and loaded
- [ ] Branch verified
- [ ] Target file(s) read and proof gap locations confirmed
- [ ] Context presented clearly
- [ ] Ready for immediate continuation of work
</success_criteria>
