# Store listing copy

Source of truth for both stores. The App Store copy is mirrored into `../store.config.json`
(pushed with `eas metadata:push`); the Play copy is pushed by `scripts/push-play-listing.mjs`.
Keep the three in step when editing.

Avoid prices, "buy"/"subscribe" wording and links to purchase pages anywhere in this copy: the iOS
app relies on guideline 3.1.3(f) (free companion to a paid web service, no purchase calls to action).

## Shared

- App name: **Qalatra**
- Category: Productivity (Apple secondary: Developer Tools)
- Website / marketing URL: https://qalatra.com
- Support URL: https://qalatra.com/support
- Privacy policy URL: https://qalatra.com/privacy
- Support email: support@qalatra.com
- Copyright: 2026 Pirate & Fox

## Apple

- Subtitle (≤30): `Tasks and agents, on the go`
- Promotional text (≤170): `Check today's priorities, capture a task in seconds, and keep an eye on your agents, all from your own Qalatra server.`
- Keywords (≤100, comma-separated, no spaces needed): `tasks,todo,productivity,agents,AI,terminal,habits,daily notes,planner,self-hosted,GTD,focus`
- What's New: not allowed on a first release.

## Google Play

- Title (≤30): `Qalatra`
- Short description (≤80): `Your Qalatra tasks, notes, habits and agent terminals, wherever you are.`

## Full description (both stores, ≤4000)

```
Qalatra is a personal task system and agent workspace that runs on a server you control: your own computer, a machine you host, or a dedicated Qalatra Cloud server. The mobile app puts that workspace in your pocket.

PLAN YOUR DAY
• A Priority view of what matters today, in the order you set
• Capture tasks in seconds with due dates, recurrence, priority, energy, context and project
• Complete, snooze or skip with a tap; recurring tasks roll forward on their own
• Search across your whole workspace

KEEP THE CONTEXT
• A daily note for each day, plus a backlog and reading list for everything that isn't today
• Habit tracking alongside your tasks
• Descriptions, notes, links and photo attachments on every task
• Browse your server's files and read or edit Markdown

WORK WITH YOUR AGENTS
• Assign tasks to the AI agents on your server and see their job status
• Open terminal sessions on your server, built for touch
• Pick up the output your agents leave behind

YOUR DATA, YOUR SERVER
Your tasks live on your Qalatra server. The app talks to it directly using an access token you create, and you can connect several servers and switch between them. With Qalatra Cloud, the server is a dedicated machine run for you, not a shared database.

REQUIREMENTS
Qalatra mobile requires a Qalatra account with hosted-app access and a Qalatra server to connect to. The Qalatra desktop app and self-hosted server are free and open source.
```
