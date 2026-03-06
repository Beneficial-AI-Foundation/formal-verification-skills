---
name: fvs:pause-work
description: Save verification context for session handoff
argument-hint: "[optional: brief note about current state]"
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
User note: $ARGUMENTS

The handoff file goes to `.formalising/fv-plans/.continue-here.md`.
Only one active handoff at a time — overwrite any existing one.

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

```bash
mkdir -p .formalising/fv-plans
```

Write to `.formalising/fv-plans/.continue-here.md` using the Write tool:

```markdown
---
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

Handoff: .formalising/fv-plans/.continue-here.md
Target:  [file]
Branch:  [branch]
Status:  [status]

To resume: /fvs:resume-work
```

</process>

<success_criteria>
- [ ] Handoff captures enough context for a fresh session to continue immediately
- [ ] Technical details are precise (line numbers, hypothesis names, exact errors)
- [ ] Discoveries/gotchas that took time to find are preserved
- [ ] Next action is specific and actionable
- [ ] File written to `.formalising/fv-plans/.continue-here.md`
</success_criteria>
