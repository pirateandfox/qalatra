# Task OS

**Your task manager, operated by Claude.**

Task OS is a local-first task management system built around a single idea: Claude shouldn't just *talk* about your tasks — it should *run* them. Via MCP, Claude has full read/write access to your task database in every conversation. It creates tasks, triages your backlog, runs your morning briefing, and dispatches autonomous agents to actually complete work.

Your data lives in a local SQLite database on your machine. Nothing goes to a server. The app is free and open source.

---

![Task OS — priority view with task detail](assets/screenshot-main.png)

![Task OS — with terminal and Claude session](assets/screenshot-terminal.png)

---

## The idea

Most people use Claude like a smart search engine. You copy-paste context in, ask a question, copy the answer out. Task OS is built on a different premise: **Claude should be a participant in your work, not a consultant you have to brief every time.**

When Claude has persistent access to your tasks — everything you need to do, when it's due, how urgent it is, what project it belongs to — the nature of the interaction changes. You stop re-explaining yourself. Claude stops giving generic advice. You start having conversations that move work forward.

In practice that looks like:

- **Morning:** *"What's my day look like?"* → Claude reads your overdue tasks, today's schedule, and upcoming deadlines, then tells you what to focus on and what to push.
- **During work:** *"I need to follow up with Sarah about the contract, remind me Thursday"* → task created, snoozed, done. No switching apps.
- **End of day:** *"Triage me"* → Claude reviews what got done, moves stale items to backlog, proposes priorities for tomorrow.
- **Agents:** Assign a Claude Code agent to a task. Task OS dispatches it, captures the output, and marks the task complete. You come back to work already done.

---

## What you get

**A local Electron app** with four views:

| View | What it shows |
|---|---|
| **Priority** | Today's tasks, grouped by context, drag to reorder |
| **Project** | Same tasks grouped by project |
| **Backlog** | Snoozed, unsurfaced, and future tasks |
| **Habits** | Daily habit tracker with streak display |

**30+ MCP tools** that Claude can call in any conversation:

```
morning_briefing      → full briefing with priorities + overdue tasks
get_todays_tasks      → today's active tasks
create_task           → create a task with full metadata
update_task           → update any field
complete_task         → mark done (auto-spawns next occurrence for recurring tasks)
snooze_task           → snooze until a date
search_tasks          → full-text search
queue_agent_job       → dispatch a Claude Code agent to work on a task
list_habits           → all habits with today's completion status
log_habit             → mark a habit done or skipped
end_of_day_triage     → review and plan tomorrow
stale_backlog_review  → surface tasks that haven't been touched recently
... and more
```

**A built-in terminal** with docked and fullscreen modes — run Claude Code alongside your task view without switching windows.

**Agents** — any folder with an `agent.config` file becomes a dispatchable agent. Assign one to a task, queue a job, and Task OS runs it with the task description as the prompt. Agents can write output files that preview directly in the app.

**Habits** — recurring behaviors with flexible scheduling. Daily, weekdays, specific days of the week (Mon/Wed/Fri, Tue/Thu). Streak dots, session notes, completion history.

**Recurrence** — full RRULE support plus shorthands. Completing a recurring task auto-spawns the next occurrence.

**Contexts** — organize tasks by area of life or work. Each context has a color. Claude uses contexts when triaging and creating tasks.

**Attachments** — connect any S3-compatible bucket (Cloudflare R2 recommended) for file storage.

**Theming** — light, dark, or system. Full color token customization.

---

## Install

Download the latest release from the [Releases page](https://github.com/pirateandfox/task-os/releases/latest):

| Platform | File |
|---|---|
| **Mac (Apple Silicon)** | `.dmg` (arm64) |
| **Mac (Intel)** | `.dmg` (x64) |
| **Windows** | `.exe` installer |
| **Linux** | `.AppImage` |

> **Windows note:** The installer is unsigned — Windows SmartScreen will warn you. Click "More info" → "Run anyway". If Claude Code fails on Windows, install it via npm: `npm install -g @anthropic-ai/claude-code`

---

## Run from source

Requires Node.js 20+.

```bash
git clone https://github.com/pirateandfox/task-os.git
cd task-os
npm install
npm install --prefix ui
npm run electron-dev
```

---

## Connect Claude

Task OS runs an MCP server on `http://localhost:3457`. Add it to `~/.claude.json`:

```json
{
  "mcpServers": {
    "task-os": {
      "type": "http",
      "url": "http://localhost:3457/mcp"
    }
  }
}
```

Restart Claude Code. The app must be running for the tools to be available.

You can also change the port and auto-update `~/.claude.json` from **Settings → MCP Server** inside the app.

---

## Agents

An agent is a folder with an `agent.config` file:

```json
{
  "name": "Research Agent",
  "description": "Researches a topic and produces a markdown report",
  "command": "claude --dangerously-skip-permissions"
}
```

Task OS scans your configured agents root and lists discovered agents in Settings. Assign an agent to a task from the detail panel. When you queue a job, Task OS spawns the agent in that folder with the task description as the prompt. Results appear as a note on the task.

Agents can attach output files to tasks via the `update_task` MCP tool:

```
update_task(task_id: "...", links: [{ url: "/absolute/path/to/report.md" }])
```

Linked `.md` files open in a markdown editor with PDF export. Linked `.html` and `.eml` files open in an email preview.

---

## Task fields

| Field | Description |
|---|---|
| **Title** | What needs doing |
| **Status** | `active`, `snoozed`, `done`, `archived` |
| **Context** | Area of life/work (`personal`, `work`, `project-x`) |
| **Project** | Optional grouping within a context |
| **Due date** | Overdue tasks appear in red |
| **Priority** | `p1`–`p4` for ordering within a section |
| **Energy** | `high`, `medium`, `low` — useful for matching tasks to your current state |
| **Type** | `task`, `event`, `reminder` |
| **Recurrence** | RRULE string or shorthand (`daily`, `weekdays`, `weekly`, `monthly`) |
| **Agent** | Path to an agent folder — enables job dispatch from the detail panel |
| **Notes** | Thread of notes with user/AI attribution |

---

## Keyboard shortcuts

| Key | Action |
|---|---|
| `N` | New task |
| `R` | Refresh |
| `` Ctrl+` `` | Toggle terminal |
| `Escape` | Close panel |

---

## Tech stack

- **Electron** + **Vite** + **React** + **TypeScript**
- **SQLite** via `better-sqlite3` (local, no server required)
- **MCP** via `@modelcontextprotocol/sdk` (StreamableHTTP, port 3457)
- **xterm.js** for the terminal
- **S3-compatible** storage for attachments (optional)

---

## Contributing

```bash
git checkout -b feature/my-feature
# make changes
git commit -m "feat: what you did"
git push -u origin feature/my-feature
gh pr create --base main
```

Releases are cut by pushing a version tag: `git tag v1.0.x && git push origin v1.0.x`. This triggers the GitHub Actions build — macOS DMG (signed + notarized), Windows EXE, Linux AppImage — and publishes to GitHub Releases. The app auto-updates.

See [`CLAUDE.md`](CLAUDE.md) for architecture, schema, and development notes.

---

## License

MIT
