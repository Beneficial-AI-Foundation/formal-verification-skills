<purpose>
Orchestrate verification planning from CODEMAP.md to produce a prioritized list of
verification targets.

Analyzes the dependency graph to determine optimal bottom-up verification order,
evaluates function complexity, checks existing spec coverage, and presents an
interactive selection interface for the user to choose their next verification target.

Output: User-selected verification target ready for /fvs:lean-specify.
</purpose>

<process>

<step name="check_codemap">
Verify CODEMAP.md exists and is current.

```bash
[ -f CODEMAP.md ] && echo "CODEMAP found" || echo "CODEMAP missing"
```

**If missing:**
```
CODEMAP.md not found. Run /fvs:map-code first to analyze the project.

Alternatively, specify a function directly:
  /fvs:lean-specify function_name
```

Warn but allow user to skip if they want to specify a target manually.

**If found:** Parse function inventory and dependency graph from CODEMAP.md.
</step>

<step name="load_verification_state">
Scan for existing verification progress.

```bash
# Find all spec files
find Specs/ -name "*.lean" 2>/dev/null

# Check each for sorry (incomplete proofs)
for f in $(find Specs/ -name "*.lean" 2>/dev/null); do
  SORRY=$(grep -c "sorry" "$f" 2>/dev/null || echo 0)
  VERIFIED=$( [ "$SORRY" -eq 0 ] && echo "yes" || echo "no" )
  echo "$f sorry=$SORRY verified=$VERIFIED"
done
```

Build verification state:
- **Verified**: Spec exists, zero sorry (fully proved)
- **In progress**: Spec exists, has sorry (partially proved)
- **Unspecified**: No spec file exists

Reference: @fv-skills/references/lean-spec-conventions.md (spec file naming and location)
</step>

<step name="analyze_dependencies">
Dispatch **fvs-dependency-analyzer** to determine optimal verification order.

Agent inputs:
- Dependency graph from CODEMAP.md
- Current verification state (which functions already verified)

**Bottom-up ordering principle:**
Verify leaf functions first, then functions whose dependencies are all verified.
This ensures each proof can rely on proven specs for callees.

Expected outputs:
- Topological sort of unverified functions
- For each function: list of unverified dependencies (blockers)
- "Ready now" set: functions whose dependencies are all verified or are leaves
- "Blocked" set: functions waiting on dependency verification

Reference: @fv-skills/references/aeneas-patterns.md (dependency patterns)
</step>

<step name="select_targets">
Dispatch **fvs-code-reader** for deeper analysis of top candidates.

Agent inputs:
- Top 10 "ready now" functions from dependency analysis
- Paths to Funs.lean and Rust source

For each candidate, evaluate:
- **Complexity estimate**: Arg count, branch count, loop presence
- **Pattern match**: Does it match known-provable patterns (arithmetic, simple branching)?
- **Value**: Is this function called by many others (high leverage)?
- **Risk**: Does it use opaque externals or complex trait dispatch?

Reference: @fv-skills/references/lean-spec-conventions.md (what makes a good spec target)
Reference: @fv-skills/references/aeneas-patterns.md (complexity indicators)
</step>

<step name="present_plan">
Display prioritized verification targets for user selection.

```
FVS -- VERIFICATION PLAN

Status: [V] verified / [P] in progress / [U] unspecified of [T] total

Ready to verify (dependencies satisfied):

  #  Function                  Complexity  Leverage  Risk
  1. scalar_mul_inner          Low         High      Low
  2. point_validate            Low         Medium    Low
  3. field_add                 Low         Low       Low
  4. batch_normalize           Medium      High      Medium
  ...

Blocked (need dependency specs first):
  - multi_scalar_mul (needs: scalar_mul_inner, point_add)
  - verify_signature (needs: hash_to_curve, scalar_mul)

---

Select a target number, or type a function name directly.
```

Wait for user selection. Store selected target for use by /fvs:lean-specify.

After selection, suggest next command:
```
Target selected: scalar_mul_inner

Next: /fvs:lean-specify scalar_mul_inner
```
</step>

</process>

<success_criteria>
- CODEMAP.md loaded and parsed (or user warned if missing)
- Existing specs scanned with sorry/verified status
- Dependency analysis produces bottom-up ordering
- Top candidates analyzed for complexity, leverage, and risk
- Prioritized list presented with clear selection interface
- User selects target, next command suggested
</success_criteria>
