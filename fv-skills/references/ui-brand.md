<ui_patterns>

Visual patterns for user-facing FVS output. Commands @-reference this file.

## Stage Banners

Use for major workflow transitions.

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 FVS >> {STAGE NAME}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**Stage names (uppercase):**
- `MAPPING CODE`
- `PLANNING TARGETS`
- `GENERATING SPEC`
- `ATTEMPTING PROOF`
- `VERIFIED`
- `STUCK`
- `BUILD ERROR`
- `GENERATING STUB`
- `UPDATING`

---

## Status Symbols

```
[OK]  Verified / Proved / Build clean
[XX]  Failed / Error / Build broken
[??]  Sorry remaining / Incomplete proof
[--]  No spec exists
[>>]  In progress
[!!]  Warning (missing dependency spec, etc.)
```

---

## Progress Display

**Project-level verification progress:**
```
Verification: 12/25 functions [OK]  3 [??]  10 [--]
```

**Function-level proof status:**
```
add_spec      [OK]  fully proved
sub_spec      [??]  2 sorry remaining
mul_spec      [--]  no spec yet
```

---

## Proof Result Blocks

**Verified:**
```
FVS >> VERIFIED

Function: {function_name}
Spec:     {spec_path}
Proof:    Complete ({N} tactic lines)
Status:   [OK] No sorry remaining

lake build: clean
```

**Stuck:**
```
FVS >> STUCK

Function: {function_name}
Spec:     {spec_path}
Status:   [??] {N} goals unsolved

Unsolved goals:
  {goal_1}
  {goal_2}

Attempted: {what was tried}

---

Options:
- Provide a hint
- "retry" with different strategy
- "simplify" postconditions
- "skip" and move on
```

**Build error:**
```
FVS >> BUILD ERROR

Function: {function_name}
Spec:     {spec_path}
Status:   [XX] Does not compile

Error:
  {lake build error output}
```

---

## Next Up Block

Always at end of major completions.

```
───────────────────────────────────────────────────────────────

>> Next Up

{suggestion with copy-paste command}

───────────────────────────────────────────────────────────────
```

---

## Agent Dispatch Indicators

```
>> Dispatching fvs-dependency-analyzer...
>> Dispatching fvs-code-reader...
>> Dispatching fvs-prover...

[OK] fvs-dependency-analyzer complete: dependency graph built
```

---

## Anti-Patterns

- Using GSD `>` prefix instead of FVS `>>`
- Using emoji (no emoji in FVS output)
- Varying box/banner widths
- Skipping status symbols in function listings
- Missing Next Up block after completions

</ui_patterns>
