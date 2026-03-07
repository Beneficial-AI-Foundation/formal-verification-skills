---
name: fvs:weekly-summary
description: Generate weekly progress report from git commits
argument-hint: "[days=7] [output_file]"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
  - Write
  - Task
---

<objective>
Generate a weekly progress report by analyzing git commits from the last N days (default 7). The report groups commits by author and uses AI to generate a narrative summary for each person in the style of a professional project update.

Output: A formatted markdown report written to the specified file or printed to console.
</objective>

<execution_context>
@~/.claude/fv-skills/workflows/weekly-summary.md
@~/.claude/fv-skills/references/weekly-summary-examples.md
@~/.claude/fv-skills/references/ui-brand.md
</execution_context>

<context>
Arguments:
- $ARG1 (optional): Number of days to look back (default: 7)
- $ARG2 (optional): Output file path (default: print to console)

The skill will:
1. Extract git commits from the last N days
2. Group commits by author
3. Analyze commit messages and file changes to understand what each person worked on
4. Generate narrative summaries in the style of professional project updates
5. Format the output as a weekly report
</context>

<process>

## Step 1: Parse Arguments

```bash
DAYS="${1:-7}"
OUTPUT_FILE="${2:-}"

# Validate DAYS is a number
if ! [[ "$DAYS" =~ ^[0-9]+$ ]]; then
  echo "Error: Days must be a positive integer"
  exit 1
fi
```

Default to 7 days if no argument provided. Accept optional output file path.

## Step 2: Collect Git Commit Data

Use git log to collect commits from the last N days with full details:

```bash
# Get date N days ago in git format
SINCE_DATE=$(date -d "$DAYS days ago" +%Y-%m-%d)

# Get commits with author, date, message, and file stats
git log --since="$SINCE_DATE" \
  --pretty=format:"COMMIT:%H%nAUTHOR:%an%nEMAIL:%ae%nDATE:%ad%nSUBJECT:%s%nBODY:%b%n---" \
  --date=short \
  --stat \
  --no-merges
```

Display collection status:
```
>> Collecting commits from the last {days} days...
>> Found {count} commits from {num_authors} authors
```

## Step 3: Group Commits by Author

Parse the git log output and organize commits by author. Extract for each commit:
- Author name and email
- Commit date
- Subject line
- Full commit message body
- Files changed with additions/deletions

Create a data structure mapping each author to their list of commits with full context.

Display:
```
>> Grouping commits by author...
   - @author1: {count} commits
   - @author2: {count} commits
   ...
```

## Step 4: Dispatch Weekly Summary Agent

For each author with commits, dispatch the fvs-weekly-summary agent to analyze their work and generate a narrative summary.

```
>> Dispatching fvs-weekly-summary for each author...
```

```
Task(
  prompt="Generate weekly summary for author.

<author_info>
Name: {author_name}
Email: {author_email}
</author_info>

<commits>
{
  For each commit:
  ---
  Date: {date}
  Subject: {subject}

  Message:
  {full_commit_message}

  Files changed:
  {file_stats}
  ---
}
</commits>

<instructions>
Analyze the commits above and generate a 2-4 sentence professional narrative summary of what this person accomplished during the period. Follow these guidelines:

1. Focus on high-level accomplishments and impact, not low-level implementation details
2. Group related work together (e.g., 'verified six functions' not 'verified function A, verified function B...')
3. Use active voice and past tense
4. Highlight technical debt reduction, infrastructure improvements, and proof completions
5. Mention specific function/module names when relevant
6. Emphasize outcomes: what was completed, what was enabled, what was improved
7. Use professional technical writing style without excessive praise

For real-world examples of good summaries, refer to the examples in the execution context (@weekly-summary-examples.md).

Return your summary starting with ## SUMMARY COMPLETE
</instructions>",
  subagent_type="fvs-weekly-summary",
  description="Weekly summary for {author_name}"
)

Wait for each agent to complete. Collect all summaries.

Display progress:
```
[OK] fvs-weekly-summary complete for @author1
[OK] fvs-weekly-summary complete for @author2
...
```

## Step 5: Format Report

Assemble the final report in the format:

```markdown
# Weekly Progress Report

**Period:** {start_date} to {end_date}
**Generated:** {current_date}

---

{For each author, alphabetically by first name:}

**@{author_handle}** {author_summary_from_agent}

{End for}

---

**Statistics:**
- Total commits: {count}
- Contributors: {num_authors}
- Files changed: {total_files_changed}
- Lines added: {total_additions}
- Lines deleted: {total_deletions}
```

## Step 6: Write Output

If output file specified:
```bash
mkdir -p $(dirname "$OUTPUT_FILE")
# Write formatted report to file
```

Display:
```
FVS >> WEEKLY SUMMARY GENERATED

Period:       {start_date} to {end_date}
Contributors: {num_authors}
Commits:      {total_commits}
Output:       {output_file or 'console'}
```

If no output file, print the report to console directly.

```
>> Next Steps

Review the summary and edit as needed for your team's weekly update.
```

</process>

<success_criteria>
- [ ] Git commits collected for specified time period (default 7 days)
- [ ] Commits grouped by author with full context
- [ ] fvs-weekly-summary agent dispatched for each author
- [ ] Narrative summaries generated in professional style
- [ ] Report formatted with clear structure and statistics
- [ ] Output written to specified file or printed to console
- [ ] Report follows the style of professional project updates
</success_criteria>
