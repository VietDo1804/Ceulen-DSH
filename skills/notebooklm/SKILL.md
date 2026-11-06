---
name: notebooklm
description: Google NotebookLM through the `notebooklm` tool (notebooklm-py CLI): notebooks, sources, grounded chat with citations, research, Studio generation (audio/video/slides/reports/quizzes/mind-maps), artifacts, downloads, notes, labels, collections, and sharing. Use when the user mentions NotebookLM, an audio overview or podcast from sources, a notebook grounded in their documents, source-grounded Q&A, or exporting NotebookLM artifacts.
---

# notebooklm — grounded work over Google NotebookLM

One tool, one argument vector:

```
notebooklm({ args: ["list", "--json"] })
notebooklm({ args: ["ask", "Summarize the findings", "-n", "<notebook-id>", "--json"] })
```

Everything after `notebooklm` on a shell command line goes into `args`, one
element per token. There is no `op` enum — the CLI is the interface, so the
skill below is a map, not a schema.

## Prerequisites

```bash
uv tool install "notebooklm-py[browser]"     # the CLI this tool drives
notebooklm login                             # in a terminal — the tool blocks it
notebooklm auth check --test --json          # verify: status alone is not proof
```

`login` is refused by the tool on purpose: it opens a browser. Run it yourself,
then let the agent drive everything else.

## Rules that save a retry

- **Navigate by full ID.** `created_at` mutates on nearly every call (it tracks
  "last touched", not creation), and `list` order / `index` are unstable. Never
  sort, dedupe, or address anything by `index`.
- **Ask for `--json`** on any command that supports it; quoting and parsing
  become the CLI's problem, not yours.
- **Pass `-n/--notebook` explicitly** even after `use`. Parallel calls and
  notebooks touched earlier in the session both rely on it.
- **Wait for sources before asking.** `source wait <src-id> -n <id> --json`, or
  check `source list` for ready sources — chat over a processing source returns
  thin, uncited answers.
- **Generation is asynchronous.** `generate …` returns a task id; poll with
  `artifact poll <task-id> -n <id> --json` or block with `artifact wait`. Pass a
  larger `timeout_ms` instead of re-running a generation that is already running.
- **Never pass cookies, storage-state, or credential JSON** through this tool.

## Command map (notebooklm-py 0.8.x)

| Area | Commands |
|------|----------|
| Health | `doctor --json`, `status`, `auth check --test --json`, `usage` |
| Notebooks | `list --json`, `create <title> --json`, `copy`, `rename -n <id> "<new>"`, `summary -n <id>`, `metadata -n <id> --json`, `delete -n <id> -y` |
| Sources | `source add <url\|path\|text> -n <id> --json`, `source add-drive <file-id> "<title>" -n <id>`, `source add-research "<query>" -n <id> --mode deep --no-wait`, `source add-async`, `source list -n <id> --json`, `source wait <src-id> -n <id> --json`, `source get`, `fulltext`, `guide`, `refresh`, `stale`, `rename`, `search`, `clean -n <id>` |
| Chat | `ask "<question>" -n <id> --json` (citations in `references[]`), `ask --new -y …`, `ask -c <conv-id> "follow up"`, `configure -n <id> --persona "<text>"`, `history -n <id> --json`, `suggest-prompts`, `suggest-next-steps` |
| Research | `research status -n <id> --json`, `research wait`, `research discover`, `research import`, `research cancel` |
| Studio generation | `generate audio \| video \| cinematic-video \| slide-deck \| report \| infographic \| quiz \| flashcards \| mind-map \| data-table -n <id>`, `generate revise-slide` |
| Artifacts | `artifact list -n <id> --json`, `get`, `choices`, `get-prompt`, `poll <task-id> -n <id> --json`, `wait`, `retry`, `suggestions`, `rename`, `export <art-id> --title "…" --type docs\|sheets`, `copy` |
| Downloads | `download audio\|video\|slide-deck\|report\|quiz\|… [output-path] -a <artifact-id>` (also `--all`, `--latest`, `--name`, `--dry-run`; `--force` overwrites) |
| Notes | `note create "<content>" -n <id> -t "<title>"`, `note list -n <id> --json`, `note get`, `note save`, `note rename`, `note delete` |
| Labels / Collections | `label add\|remove\|create\|rename\|delete\|emoji\|generate\|list\|sources`, `collection add\|remove\|create\|rename\|delete\|list\|notebooks` |
| Sharing | `share status -n <id> --json`, `share public --enable\|--disable`, `share add <email> --permission viewer\|editor`, `share remove`, `share update`, `share view-level full\|chat` |
| Organization | `profile list --json`, `profile switch\|create\|rename\|delete`, `language get\|list\|set`, `mcp install` |

## Gates the tool enforces

| Situation | What to do |
|-----------|-----------|
| `delete`, `share *`, `clear`, `auth logout`, `skill uninstall`, `research cancel`, `mcp install`, `--force` overwrite, `ask --new`, `history --clear` | Pass `confirm: true` **only after the user agreed**. |
| The same commands that can prompt (`delete`, `source delete`, `artifact delete`, `note delete`, `profile delete`, `label delete`, `collection delete`, `source clean`, `share remove`, `ask --new`) | Append `--yes`, or the call has nothing to answer the prompt with. |
| `login` / `auth login` | Refused: ask the user to run it in a terminal. |

## Working pattern

1. `args: ["list", "--json"]` — is there already a notebook for this?
2. Create or pick one; capture the full `id`.
3. Add sources one at a time (`source add` takes exactly one), then `source wait`.
4. Ask with `--json` and quote the `references[]` that back the answer.
5. For an Audio Overview or deck: `generate … -n <id>`, then `artifact poll`
   until done, then `download … -a <artifact-id> <output-path>`.
