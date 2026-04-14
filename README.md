# Task OS

**Project management for the AI era.**

Give your AI agent full read/write access to your tasks, daily notes, and habit log — all in one local app. Not just a task manager your agent can read. A system your agent actively operates: creating tasks, triaging your backlog, running your morning briefing, dispatching autonomous agents to complete work, and building a persistent memory of your days that makes weekly reviews and long-term planning actually useful.

Built for Claude Code via MCP. Works with any command-line AI agent.

Your data lives in a local SQLite database on your machine. Nothing goes to a server. The app is free and open source.

---

![Task OS — priority view, task detail, and Claude running in the integrated terminal](assets/screenshot-terminal.png)

---

## The idea

The AI project management space has split into two camps. One camp uses markdown files — tasks as text, everything in a folder, Claude reads the files. Simple, but no structure, no recurrence, no real query capability. The other camp keeps using traditional task managers and just asks Claude questions about them — but Claude has no write access, no persistence, no memory across sessions.

Task OS is a third approach: **a structured task database that your AI agent lives inside of.**

Your agent gets full read/write access to your tasks, your daily notes, and your habit log simultaneously. That combination is what makes it different. Your tasks capture what you need to do. Your daily notes capture everything else — the meeting that went sideways, the idea you had at 2pm, the thing you wanted to remember but didn't have time to turn into a task. Together, they give your agent a real memory of your work across days and weeks.

Task OS was designed for Claude Code and all the examples use it — but it works with any command-line AI agent. That's configurable in Settings.

In practice that looks like:

- **Morning:** *"What's my day look like?"* → your agent reads your overdue tasks, today's schedule, upcoming deadlines, and yesterday's notes, then tells you what to focus on and what to push.
- **During work:** *"I need to follow up with Sarah about the contract, remind me Thursday"* → task created, snoozed, done. No switching apps.
- **End of day:** *"Triage me"* → your agent reviews what got done, moves stale items to backlog, proposes priorities for tomorrow.
- **Weekly review:** *"How was my week?"* → your agent reads all seven daily notes plus task completion history and gives you a real account of what happened — including the small things that never became tasks but mattered.
- **Agents:** Assign an agent to a task. Task OS dispatches it, captures the output, and marks the task complete. You come back to work already done.

The terminal is built in so you never leave the context. Claude runs in a panel below your task list. The daily note is one click away. Everything is in one place because context-switching is where work dies.

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

**Agents** — any folder with an `agent.config` file becomes a dispatchable agent. Assign one to a task, queue a job, and Task OS runs it with the task description as the prompt. Agents can write output files that preview directly in the app. Agents can also define `output_rules` to extract data from their output and automatically attach links back to the task.

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

## First-time setup

Open **Settings** (gear icon, top right) and configure two things before you start:

**1. Working directory**

Set this to your main projects folder — the directory where your work lives:

```
/Users/you/IdeaProjects        # Mac/Linux
C:\Users\you\IdeaProjects      # Windows
```

This is the working directory for the built-in terminal and the root Task OS scans for agents. Everything flows from here.

**2. Agent command**

Task OS dispatches agents using a configurable CLI command. The default is:

```
claude --dangerously-skip-permissions
```

**Task OS works with any command-line agent, not just Claude.** If you use a different AI CLI, a custom script, or your own agent runner — change this to whatever command invokes it. Claude is what we use and what all the examples show, but it's not hardwired.

Per-agent overrides are also available — each agent folder can specify its own command in `agent.config`, so you can mix different agents across different tasks.

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

**Output rules** — agents can parse their own stdout and automatically add links to the Task OS task. Add an `output_rules` array to `agent.config`:

```json
{
  "name": "My Agent",
  "command": "my-cli --flag '{description}'",
  "output_rules": [
    {
      "pattern": "Task ID: ([a-f0-9-]{36})",
      "action": "add_link",
      "url": "https://yourapp.com/tasks/{1}"
    }
  ]
}
```

`pattern` is a JavaScript regex. `{1}`, `{2}`, etc. reference capture groups. When the agent job completes successfully, Task OS applies each rule against the raw output and adds matching links to the task. Rules live in your agent's repo — nothing is configured globally in Task OS.

**Starter agents:** Clone [taskos-projects-template](https://github.com/pirateandfox/taskos-projects-template) as your working directory to get a set of ready-to-use agents — research, writing, triage, and more. Point Settings → Working Directory at the cloned folder to activate them.

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
