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
Stage verification-related files and create a structured git commit with a framework-adaptive prefix. Tracks verification progress by counting sorry occurrences in spec files.

Output: Git commit with message `checkpoint({framework}): {description} - {progress}`
</objective>

<execution_context>
@~/.claude/fv-skills/references/ui-brand.md
</execution_context>

<context>
Checkpoint description: $ARGUMENTS (optional -- will prompt if empty).

- Framework-agnostic command (no lean- prefix) that adapts commit prefix by detected framework
- Locked decision: commit prefix uses detected framework name
- Stages .lean files and .formalising/ changes automatically
</context>

<process>

## Step 1: Detect framework

Use project markers to determine the verification framework:

```bash
# Check for Lean project markers
if [ -f "lakefile.toml" ] && [ -f "lean-toolchain" ]; then
  FRAMEWORK="lean"
  echo "[OK] Lean project detected"
# Check for Verus project markers (future-proofing)
elif find . -name "*.rs" -path "*/verus*" 2>/dev/null | head -1 | grep -q .; then
  FRAMEWORK="verus"
  echo "[OK] Verus project detected"
else
  FRAMEWORK="fv"
  echo "[--] No specific framework detected, using generic 'fv' prefix"
fi
```

## Step 2: Count verification progress

For Lean projects, count sorry occurrences in spec files:

```bash
if [ "$FRAMEWORK" = "lean" ]; then
  # Count files with sorry
  SORRY_FILES=$(grep -rl "sorry" --include="*.lean" Specs/ 2>/dev/null | wc -l | tr -d ' ')

  # Count total sorry occurrences
  SORRY_TOTAL=$(grep -r "sorry" --include="*.lean" Specs/ 2>/dev/null | wc -l | tr -d ' ')

  # Count fully verified specs (zero sorry)
  VERIFIED_FILES=$(find Specs/ -name "*.lean" 2>/dev/null | while read f; do
    grep -q "sorry" "$f" || echo "$f"
  done | wc -l | tr -d ' ')

  TOTAL_SPECS=$(find Specs/ -name "*.lean" 2>/dev/null | wc -l | tr -d ' ')

  echo "Specs: $TOTAL_SPECS total, $VERIFIED_FILES verified, $SORRY_FILES with sorry"
  echo "Sorry count: $SORRY_TOTAL"
fi
```

Parse `$ARGUMENTS` as the checkpoint description. If `$ARGUMENTS` is empty:

```
What did you verify? (e.g., "FieldElement51.add" or "scalar_mul bounds proof")
```

Wait for user to provide description.

## Step 3: Stage relevant files

Stage modified verification files:

```bash
# Stage all modified .lean files in Specs/ directory
git add Specs/**/*.lean 2>/dev/null

# Stage .formalising/ directory changes (stubs, CODEMAP updates, handoff)
git add .formalising/ 2>/dev/null

# Show what will be committed
STAGED_COUNT=$(git diff --staged --stat | tail -1)
echo "Staged: $STAGED_COUNT"
```

Display staged files for user confirmation:

```bash
git diff --staged --stat
```

If nothing is staged:

```
FVS >> [XX] NO CHANGES TO CHECKPOINT

No modified verification files found. Make changes first, then run /fvs:checkpoint.
```

Exit -- do not proceed.

## Step 4: Create structured commit

Build the commit message with framework-adaptive prefix:

```bash
# Format: checkpoint({framework}): {description} - {progress}
# Example: checkpoint(lean): FieldElement51.add - 3/5 sorry resolved

DESCRIPTION="$ARGUMENTS"

if [ "$FRAMEWORK" = "lean" ] && [ "$TOTAL_SPECS" -gt 0 ]; then
  PROGRESS="$VERIFIED_FILES/$TOTAL_SPECS specs verified, $SORRY_TOTAL sorry remaining"
  git commit -m "checkpoint($FRAMEWORK): $DESCRIPTION - $PROGRESS"
else
  git commit -m "checkpoint($FRAMEWORK): $DESCRIPTION"
fi
```

## Step 5: Display confirmation

```bash
COMMIT_HASH=$(git rev-parse --short HEAD)
COMMITTED_FILES=$(git diff-tree --no-commit-id --name-only -r HEAD | wc -l | tr -d ' ')
```

```
FVS >> CHECKPOINT CREATED

Commit:   checkpoint({framework}): {description}
Hash:     {commit_hash}
Files:    {N} files committed
Progress: {verified}/{total} specs verified, {sorry_total} sorry remaining
```

If this was a Lean project and sorry count decreased since the last checkpoint, also display:

```
[OK] Progress: sorry count reduced
```

</process>

<success_criteria>
- [ ] Framework detected from project markers (lean/verus/fv)
- [ ] Sorry count tracked for progress reporting
- [ ] Verification-related files staged automatically
- [ ] Structured commit with framework-adaptive prefix created
- [ ] Progress summary displayed
</success_criteria>
