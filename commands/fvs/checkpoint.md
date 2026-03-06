---
name: fvs:checkpoint
description: Create structured verification checkpoint commit
argument-hint: "<description> (what was verified)"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
---

<objective>
Stage verification-related files and create a structured git commit with a framework-adaptive prefix. Tracks verification progress by counting unfinished proof gaps across the project.

Output: Git commit with message `checkpoint({framework}): {description} - {progress}`
</objective>

<execution_context>
@~/.claude/fv-skills/references/ui-brand.md
</execution_context>

<context>
Checkpoint description: $ARGUMENTS (optional -- will prompt if empty).

- Framework-agnostic command that adapts commit prefix by detected framework
- Stages all modified verification-related files automatically
</context>

<process>

## Step 1: Detect framework

Use project markers to determine the verification framework:

```bash
# Detect from project files — extend this list as new frameworks are supported
if [ -f "lakefile.toml" ] || [ -f "lakefile.lean" ] || [ -f "lean-toolchain" ]; then
  FRAMEWORK="lean"
  PROOF_EXTENSIONS="*.lean"
  GAP_PATTERN="sorry"
elif [ -f "Cargo.toml" ] && grep -rq "verus!" --include="*.rs" . 2>/dev/null; then
  FRAMEWORK="verus"
  PROOF_EXTENSIONS="*.rs"
  GAP_PATTERN="assume(false)\|todo!()"
elif [ -f "dune-project" ] || [ -f "_CoqProject" ]; then
  FRAMEWORK="coq"
  PROOF_EXTENSIONS="*.v"
  GAP_PATTERN="Admitted\.\|admit\."
else
  FRAMEWORK="fv"
  PROOF_EXTENSIONS=""
  GAP_PATTERN=""
fi
echo "Framework: $FRAMEWORK"
```

## Step 2: Count verification progress

If a framework was detected, count proof gaps:

```bash
if [ -n "$GAP_PATTERN" ] && [ -n "$PROOF_EXTENSIONS" ]; then
  GAP_COUNT=$(grep -r "$GAP_PATTERN" --include="$PROOF_EXTENSIONS" . 2>/dev/null | wc -l | tr -d ' ')
  PROOF_FILES=$(find . -name "$PROOF_EXTENSIONS" 2>/dev/null | wc -l | tr -d ' ')
  COMPLETE_FILES=$(find . -name "$PROOF_EXTENSIONS" 2>/dev/null | while read f; do
    grep -q "$GAP_PATTERN" "$f" || echo "$f"
  done | wc -l | tr -d ' ')
  echo "Proof files: $PROOF_FILES total, $COMPLETE_FILES complete, $GAP_COUNT gaps remaining"
fi
```

Parse `$ARGUMENTS` as the checkpoint description. If `$ARGUMENTS` is empty:

```
What did you verify? (e.g., "mul bounds proof" or "switching to ring strategy")
```

Wait for user to provide description.

## Step 3: Stage relevant files

Stage modified verification files:

```bash
# Stage all modified proof and spec files
git add -A .formalising/ 2>/dev/null

# Stage proof files based on detected framework
if [ -n "$PROOF_EXTENSIONS" ]; then
  git add $(git diff --name-only --diff-filter=M | grep "$PROOF_EXTENSIONS" | head -50) 2>/dev/null
fi

# Show what will be committed
git diff --staged --stat
```

If nothing is staged:

```
FVS >> [XX] NO CHANGES TO CHECKPOINT

No modified verification files found. Make changes first, then run /fvs:checkpoint.
```

Exit -- do not proceed.

## Step 4: Propose commit message

Draft a commit message following these rules:
- Conventional commit format: `checkpoint({framework}): {description}`
- Subject line under 50 characters, imperative mood
- Add a body only if changes are complex (wrap at 72 chars)
- Focus on WHAT changed and WHY, not how
- Be as SHORT as possible while remaining descriptive
- NEVER add "Co-Authored-By" lines or reference AI tools/assistants

Present the proposed message and staged diff to the user for approval:

```
FVS >> PROPOSED CHECKPOINT

checkpoint({framework}): {description}

{body, only if needed}

Staged files:
{git diff --staged --stat output}

Approve this commit message, or provide an alternative:
```

Wait for user confirmation. If the user provides an alternative message, use that instead.

## Step 5: Commit and confirm

```bash
git commit -m "{approved message}"
COMMIT_HASH=$(git rev-parse --short HEAD)
```

```
FVS >> CHECKPOINT CREATED

{commit hash} {commit subject}
Progress: {complete}/{total} proof files complete, {gap_count} gaps remaining
```

</process>

<success_criteria>
- [ ] Framework detected from project markers
- [ ] Proof gap count tracked for progress reporting
- [ ] Verification-related files staged automatically
- [ ] Structured commit with framework-adaptive prefix created
- [ ] Progress summary displayed
</success_criteria>
