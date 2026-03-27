# Task OS

A personal task management system built for people who work with Claude. Tasks live in a local SQLite database. Claude connects via MCP and can create, update, triage, and act on tasks directly. An Electron app provides the UI.

![Task OS](assets/icon.png)

---

## Install

Download the latest release for your platform from the [Releases page](https://github.com/pirateandfox/task-os/releases/latest):

- **Mac** — `.dmg` (arm64 for Apple Silicon, x64 for Intel)
- **Windows** — `.exe` installer (unsigned — Windows will show a SmartScreen warning, click "More info" → "Run anyway")
- **Linux** — `.AppImage` (make executable with `chmod +x`, then run)

---

## Run from Source

Requires Node.js 20+.

```bash
git clone https://github.com/pirateandfox/task-os.git
cd task-os
npm install
npm install --prefix ui
npm run electron-dev
```

---

## Connect Claude Code

Task OS runs an MCP server on `http://localhost:3457`. Add it to your `~/.claude.json`:

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

Restart Claude Code after adding it. The Task OS app must be running for the MCP tools to be available.

You can also change the port and auto-update `~/.claude.json` from the Settings panel inside the app.

---

## Settings

Open Settings from the top-right gear icon.

### Terminal Working Directory

Sets the working directory for the built-in terminal. This is also the root directory Task OS scans for agents (see below).

```
/Users/you/IdeaProjects
```

### MCP Server Port

Default is `3457`. Click **Apply** to save the port and automatically update `~/.claude.json`. Restart Claude Code after applying.

---

## Agents

An agent is a folder with an `agent.config` file. Task OS scans your terminal working directory recursively for these folders and lists discovered agents in Settings.

### agent.config format

```json
{
  "name": "My Agent",
  "description": "What this agent does",
  "command": "claude --dangerously-skip-permissions"
}
```

- `name` — display name (defaults to folder name)
- `description` — shown in the Settings panel
- `command` — how to invoke the agent (defaults to `claude --dangerously-skip-permissions`)

### Assigning an agent to a task

In the task detail panel, set the **Agent** field to point to the agent's folder. When you queue the agent job, Task OS runs the agent in that folder with the task's description as the prompt.

---

## File Previews (Markdown & Email)

Task OS can preview `.md` files and `.eml`/HTML email files directly in the app. Agents can attach output files to a task so they appear as clickable preview buttons in the task detail panel.

### How agents should attach files

After writing a file, the agent should call `update_task` with a `links` array:

```
update_task(
  task_id: "abc123",
  links: [
    { url: "/absolute/path/to/output/document.md" },
    { url: "/absolute/path/to/output/email-draft.html" }
  ]
)
```

The file path must be absolute. Task OS reads it directly from disk when you click the preview button.

### What to tell your agents

Include this in your agent's system prompt or CLAUDE.md:

```
After writing any output files (markdown documents, email drafts, etc.),
attach them to the task using update_task with a links array containing
the absolute file path as the url. Example:

update_task(task_id: "...", links: [{ url: "/absolute/path/to/file.md" }])

This makes the file available for preview in Task OS.
```

### Supported file types

| Extension | Preview |
|---|---|
| `.md` | Markdown editor with PDF export |
| `.html`, `.eml` | Email preview |

---

## MCP Tools Reference

Key tools available to Claude:

| Tool | Description |
|---|---|
| `get_todays_tasks` | Today's active tasks |
| `morning_briefing` | Full morning briefing with priorities |
| `create_task` | Create a new task |
| `update_task` | Update any field including links, status, agent |
| `complete_task` | Mark a task done |
| `snooze_task` | Snooze until a date |
| `search_tasks` | Full-text search |
| `get_overdue_tasks` | All overdue tasks |
| `queue_agent_job` | Queue an agent job for a task |
| `get_daily_note` | Read today's daily note |
| `update_daily_note` | Append to today's daily note |

---

## Tech Stack

- **Electron** 41 + **Vite** + **React** + **TypeScript**
- **SQLite** via `better-sqlite3`
- **MCP** via `@modelcontextprotocol/sdk` (StreamableHTTP transport)
- **S3-compatible** attachment storage (Cloudflare R2 recommended)

---

## License

MIT
