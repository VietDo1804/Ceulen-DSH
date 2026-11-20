/**
 * How gpt-6.1-sol works in this harness, written down for cheaper lead models.
 * Measured 2026-11-01..20: sol opened 73% of turns with one codemode batch
 * whose nested calls were read 1604 · grep 725 · glob 611 · skill 220 ·
 * todo_write 164 · munin_search 142; flash opened 49% with bash and its nested
 * calls were bash 2292 · read 341 · grep 103 · glob 15. Sol delegated after
 * orientation (median call #8, ~60k context), reviewer more often than scout.
 *
 * The template is copied from sol's real opening scripts. The distill line only
 * touches documented shapes (`read` → `lines`) and JSON-stringifies the rest,
 * because a template the model copies must not invent result fields.
 */
export const PLAYBOOK = `## Harness playbook
How the strongest models in this harness work. Do the same.

1. Open a new task with ONE \`codemode\` orientation script that gathers what you need in parallel, not a run of bash calls:
\`\`\`js
const r = await Promise.allSettled([
  tools.grep({ pattern: 'clampText\\\\(', path: 'src', include: '*.ts' }),
  tools.glob({ pattern: 'src/**/*.test.ts' }),
  tools.read({ file_path: 'src/core/tools.ts', offset: 340, limit: 60 }),
  tools.munin_search({ query: '<topic> decision', topK: 3 }),
])
return r.map((x, i) => ({ i, text: (x.status === 'fulfilled' ? (x.value.lines ? x.value.lines.map(l => l.text).join('\\n') : JSON.stringify(x.value)) : String(x.reason)).slice(0, 1500) }))
\`\`\`
   Add \`tools.skill({ name })\` when a listed skill covers the task.
2. Pick the tool by the need, inside codemode too (\`tools.grep\`, never \`tools.bash\` with grep):
   - text in files → \`grep\` (\`fff_grep\` for a vague folder) · file names → \`glob\` (\`find_files\` when unsure)
   - file contents → \`read\` with offset/limit; it is also what lets \`edit\`/\`write\` accept the file
   - one change → \`edit\` · several hunks or files → \`apply_patch\` · new file → \`write\`
   - run builds, tests, git, servers, scripts → \`bash\`
   - past decisions → \`munin_search\` · a 3+ step task → \`todo_write\` · a choice only the user can make → \`ask_user_question\`
   - one operation → call the tool directly; codemode is for 2+ calls or filtering.
3. After orienting, delegate only when it pays; otherwise do the work yourself:
   - \`scout\`: the answer still needs many more files read or an unfamiliar area. Give a precise question and the paths.
   - parallel children: 2+ independent parts that each need real work.
   - \`reviewer\`: new logic, changed behaviour or API, or a risky area (security, data loss, concurrency). Skip it for mechanical edits (renames, added arguments, formatting) and say so in one line.
   - A child you could replace with 3 tool calls is waste.`
