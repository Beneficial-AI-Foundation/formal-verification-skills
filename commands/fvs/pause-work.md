---
name: fvs:pause-work
description: Save verification context for session handoff
argument-hint: "[path] [note]"
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - Grep
---

<objective>
Create a handoff document in `.formalising/fv-plans/` that preserves complete verification context across session boundaries (compaction, new conversation, etc.).

This is NOT about git commits — it's about capturing the mental model and proof state that would be lost when context resets.
</objective>

<execution_context>
@~/.claude/fv-skills/references/ui-brand.md
</execution_context>

<context>
Arguments: $ARGUMENTS

**Default handoff file:** `.formalising/fv-plans/.continue-here.md`.

**Optional first positional token = a destination.** The first token in `$ARGUMENTS` is treated as a destination ONLY if it contains `/` or ends in `.md`. Otherwise the entire `$ARGUMENTS` string is the user note (so a one-word note like `stuck` is never misread as a directory).

Resolution rule:

- **No path-like first token:** write the legacy default `.formalising/fv-plans/.continue-here.md`. The whole argument string is the user note.
- **First token ends in `.md`:** that exact path is the handoff file.
- **First token is otherwise path-like (contains `/`):** treat it as a directory and write `<token>/.continue-here.md` inside it.

When a path-like first token is present, the remaining text after it is the user note. Overwrite ONLY the selected handoff file (parallel handoffs to distinct destinations do not clobber each other).

Examples:

```text
/fvs:pause-work
  -> .formalising/fv-plans/.continue-here.md

/fvs:pause-work .formalising/fv-plans/CKA-from-KEM
  -> .formalising/fv-plans/CKA-from-KEM/.continue-here.md

/fvs:pause-work .formalising/fv-plans/CKA-from-KEM/security-handoff.md
  -> .formalising/fv-plans/CKA-from-KEM/security-handoff.md
```

This command has access to the FULL current conversation context. Extract everything relevant from prior messages, tool results, and discoveries made during this session.
</context>

<process>

## Step 1: Gather State from Conversation

Extract from the current conversation context:

1. **Target file(s)**: Which spec/proof file(s) are being worked on
2. **Branch**: Current git branch
3. **Proof gaps**: Locations of unfinished proofs (line numbers and what each needs)
4. **Proof state**: Available hypotheses, goal structure
5. **Discoveries**: Insights found during this session (lemma identities, tactic behavior, gotchas)
6. **Blockers**: What's preventing progress and why
7. **Decisions made**: Approaches chosen/rejected with rationale
8. **Strategy**: The current plan of attack
9. **Next action**: Exactly what to do first when resuming

## Step 2: Check Modified Files

```bash
git diff --stat HEAD
git branch --show-current
```

## Step 3: Read Current State of Target Files

Read the proof gap locations and surrounding proof context from the target file(s) to capture the exact current state.

## Step 4: Write Handoff

Resolve `HANDOFF_FILE` from `$ARGUMENTS` per the rule in `<context>`:

- no path-like first token (no `/` and not ending in `.md`): `.formalising/fv-plans/.continue-here.md`;
- first token ends in `.md`: that exact path;
- first token is otherwise path-like (contains `/`): `<token>/.continue-here.md`.

```bash
mkdir -p "$(dirname "$HANDOFF_FILE")"
```

Write to `HANDOFF_FILE` (overwrite only that file) using the Write tool:

```markdown
---
fvs_handoff: true
target: <spec file path>
branch: <git branch>
last_updated: <UTC timestamp>
status: <in_progress|blocked|stuck>
proof_gaps: <number of unfinished proofs>
---

# Verification Handoff

## What We're Proving
[Function name, theorem name, what it means]

## Current State
[Exact position: which proof gap, what the goal looks like, what's been established]

## Discoveries
[Key insights, gotchas, things that would take time to rediscover]

## Blockers
[What's preventing progress, with full technical detail]

## Decisions
[Approaches chosen/rejected with rationale]

## Strategy
[The plan of attack going forward]

## Key Hypotheses & Definitions
[Important hypothesis names, file locations, definition references]

## Next Action
[Exactly what to do first when resuming — be specific enough for a fresh session]
```

## Step 5: Confirm

```
FVS >> PAUSED

Handoff: [HANDOFF_FILE]
Target:  [file]
Branch:  [branch]
Status:  [status]

To resume: /fvs:resume-work [same path or directory]
```

</process>

<success_criteria>
- [ ] Handoff captures enough context for a fresh session to continue immediately
- [ ] Technical details are precise (line numbers, hypothesis names, exact errors)
- [ ] Discoveries/gotchas that took time to find are preserved
- [ ] Next action is specific and actionable
- [ ] File written to the resolved handoff file (default `.formalising/fv-plans/.continue-here.md`, or the destination from `$ARGUMENTS`)
</success_criteria>
