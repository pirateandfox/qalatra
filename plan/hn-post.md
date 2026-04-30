# HN Post — Qalatra Launch

**Title:** Show HN: Qalatra - Agentic task runner utilizing your Claude Code subscription

---

I've been building and using this every day for about a month. Every time I hit a wall, I code around it. It updates several times a day and gets meaningfully better every single day. I'm posting it now because it's already changed how I work and I want to know if it does the same for others.

Also, with the conversation about Claude's disabling subscriptions for 3rd party apps, this is an agentic system (you can build thousands of agents and run them on schedules) that uses Claude Code directly on the command line, so your subscription works just fine.

I run Pirate & Fox, a 25-year agency, serve as CTO for a large non-profit, and juggle multiple projects simultaneously. My need for killer task management is high. I've tried everything.
The AI project management space has split into two camps that both feel wrong to me. One uses markdown files as tasks — flexible but no structure, no recurrence, no real queryability. The other keeps using traditional task managers and asks Claude questions about them — but Claude has no write access, no persistence, no memory across sessions.
I wanted a third thing: a structured task database that Claude actually lives inside.

Qalatra is a local Electron app backed by SQLite. Nothing goes to a server. Your AI agent connects via MCP and gets 30+ tools: it creates tasks, triages your backlog, runs a morning briefing, and dispatches autonomous agents to complete work.
The piece I'm most excited about is the combination of tasks + daily notes + habit log. Your tasks capture what you need to do. Your daily notes capture everything else — the meeting that went sideways, the idea at 2pm, the thing you wanted to remember but didn't have time to make a task for. Together they give your agent a real memory of your work. Ask for a weekly review and it can actually tell you what happened — including the small things.

The terminal is built in. Your agent runs in a panel below your task list. Everything is in one place because context-switching is where work dies.
It works with any command-line agent — not just Claude. That's configurable in settings. Claude is what I use and all the examples show it, but it's not hardwired.

This is brand new software that is still being born. The terminal has occasional glitches — sometimes you have to close and reopen it. Windows support is actively being improved but it was built on Mac and works better there right now. It is not stable software in the traditional sense. What it is: something I use every day that keeps getting better, fast.

I'm looking for early users and feedback. The more you put into it — building agents, writing good daily notes, letting Claude actually manage your backlog — the more you get out of it. I'd love to know what breaks for you, what you'd change, and what workflows you'd build that I haven't thought of.

GitHub: https://github.com/pirateandfox/qalatra

Mac, Windows, Linux builds on the releases page. MIT licensed.