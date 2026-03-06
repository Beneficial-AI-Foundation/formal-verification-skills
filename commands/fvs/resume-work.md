---
name: fvs:resume-work
description: Resume verification from saved handoff context
argument-hint: ""
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

## Step 1: Load Handoff

```bash
[ -f .formalising/fv-plans/.continue-here.md ] && echo "Handoff found" || echo "No handoff found"
```

If not found: inform user and suggest `/fvs:plan` to pick a new target.

Read the handoff file fully.

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
