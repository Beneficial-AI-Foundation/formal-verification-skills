<purpose>
Orchestrate weekly progress report generation by analyzing git commits.

Takes a time period (default: last 7 days), extracts commit history, groups by author,
and generates professional narrative summaries for each contributor.

The result is a formatted report suitable for team updates, management reviews, or
project documentation.

Output: Formatted markdown report to file or console
</purpose>

<process>

<step name="parse_arguments">
Accept optional arguments for customization.

**Arguments:**
- Days to look back (default: 7)
- Output file path (optional, default: print to console)

**Validation:**
- Days must be a positive integer
- Output file path (if provided) must be writable

**Example invocations:**
```
/fvs:weekly-summary                    # Last 7 days, print to console
/fvs:weekly-summary 14                 # Last 14 days, print to console
/fvs:weekly-summary 7 weekly.md        # Last 7 days, write to weekly.md
```
</step>

<step name="collect_commits">
Extract git commit history for the specified period.

**Git command:**
```bash
SINCE_DATE=$(date -d "$DAYS days ago" +%Y-%m-%d)

git log --since="$SINCE_DATE" \
  --pretty=format:"COMMIT:%H%nAUTHOR:%an%nEMAIL:%ae%nDATE:%ad%nSUBJECT:%s%nBODY:%b%n---" \
  --date=short \
  --stat \
  --no-merges
```

**What to extract:**
- Commit hash (for reference)
- Author name and email
- Commit date
- Subject line (first line of commit message)
- Full commit body (remaining lines)
- File statistics (additions/deletions per file)

**Filters:**
- Exclude merge commits (--no-merges)
- Only commits within date range
- All branches (default git log behavior)

**Status display:**
```
>> Collecting commits from the last {days} days...
>> Found {count} commits from {num_authors} authors
```

If no commits found:
```
No commits found in the last {days} days.

The repository may be inactive, or you may need to check:
- Are you in a git repository?
- Does the repository have commits in this period?
- Try increasing the days parameter.
```

Exit gracefully.
</step>

<step name="group_by_author">
Parse git log output and organize commits by author.

**Data structure:**
For each author, collect:
- Name and email
- List of commits, each with:
  - Date
  - Subject
  - Full message body
  - Files changed (with +/- stats)

**Author identification:**
- Use both name and email to identify unique authors
- Handle case variations (e.g., "John Doe" vs "john doe")
- Normalize email addresses (lowercase)

**Display:**
```
>> Grouping commits by author...
   - @alessandro: 12 commits
   - @markus: 8 commits
   - @liao: 15 commits
   - @truang: 10 commits
```

**Sorting:**
- Sort authors alphabetically by first name
- This matches the style of team reports
</step>

<step name="generate_summaries">
For each author, dispatch **fvs-weekly-summary** agent to generate narrative.

**Why use an agent?**
The narrative generation requires:
- Pattern recognition across multiple commits
- Technical understanding of domain terms (proofs, specs, verification)
- Natural language generation with professional tone
- Judgment about what to emphasize vs. omit

**Agent input:**
```
<author_info>
Name: {author_name}
Email: {author_email}
</author_info>

<commits>
{all commits for this author, formatted}
</commits>

<instructions>
{guidelines from agent definition}
</instructions>
```

**Agent output:**
2-4 sentence narrative summary starting with ## SUMMARY COMPLETE

**Parallel execution:**
Launch agents for all authors in parallel if possible, since they're independent.

**Status display:**
```
>> Dispatching fvs-weekly-summary for each author...

[OK] fvs-weekly-summary complete for @alessandro
[OK] fvs-weekly-summary complete for @markus
[OK] fvs-weekly-summary complete for @liao
[OK] fvs-weekly-summary complete for @truang
```

**Error handling:**
If agent fails for an author, fall back to commit list:
```
@author: Made 8 commits [details omitted due to processing error]
```
</step>

<step name="format_report">
Assemble final report with standard structure.

**Report template:**
```markdown
# Weekly Progress Report

**Period:** {start_date} to {end_date}
**Generated:** {current_date_time}

---

{for each author alphabetically}

**@{author_handle}** {narrative_summary_from_agent}

{end for}

---

**Statistics:**
- Total commits: {total_commits}
- Contributors: {num_authors}
- Files changed: {unique_files_changed}
- Lines added: {total_additions}
- Lines deleted: {total_deletions}
```

**Author handle extraction:**
- Use first name from author name (e.g., "Alessandro Mazza" → "alessandro")
- Lowercase and remove special characters
- Fall back to email username if name parsing fails

**Statistics calculation:**
- Count unique files across all commits
- Sum all additions and deletions
- Include metrics in footer

**Formatting guidelines:**
- Use bold for author handles: **@author**
- Start each author's summary on the same line as their handle
- Separate authors with blank lines
- Include horizontal rules (---) for visual separation
</step>

<step name="write_output">
Write report to specified destination.

**If output file provided:**
```bash
mkdir -p $(dirname "$OUTPUT_FILE")
cat > "$OUTPUT_FILE" <<EOF
{formatted_report}
EOF
```

Display:
```
FVS >> WEEKLY SUMMARY GENERATED

Period:       {start_date} to {end_date}
Contributors: {num_authors}
Commits:      {total_commits}
Output:       {output_file}

Report written successfully.
```

**If no output file (print to console):**
Print the formatted report directly to stdout.

Display:
```
FVS >> WEEKLY SUMMARY
{formatted_report}
```

**Next steps message:**
```
>> Next Steps

Review the summary and edit as needed for your team's weekly update.
You can save this output using:
  /fvs:weekly-summary {days} output.md
```
</step>

</process>

<success_criteria>
- Git commits collected for specified period with full context
- Commits grouped by author with normalized identification
- Agent summaries generated with professional tone and appropriate detail
- Report formatted with clear structure matching team update style
- Output written to file or console as specified
- Clear feedback provided throughout the process
- Graceful handling of edge cases (no commits, agent failures)
</success_criteria>

<edge_cases>

**No commits in period:**
Display helpful message and exit gracefully.

**Single author:**
Still generate full report format (don't special-case it).

**Very large number of commits for one author:**
Agent should still produce 2-4 sentence summary (not scale with commit count).

**Malformed commit messages:**
Agent should handle gracefully and focus on file changes if messages are unclear.

**Author with only trivial commits:**
Agent should still generate a professional summary, even if brief.

**Multiple email addresses for same person:**
Current implementation treats as separate authors. Future enhancement could add email mapping.

</edge_cases>
