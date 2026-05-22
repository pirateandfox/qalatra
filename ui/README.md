# Qalatra UI

React + TypeScript frontend for Qalatra Desktop and future web clients.

The UI talks to Qalatra Server over the authenticated HTTP API. In desktop dev, Electron starts a local server automatically. In remote mode, Settings -> Instances selects another Qalatra Server URL and bearer token.

## Commands

```bash
npm install --prefix ui
npm run dev --prefix ui
npm run build --prefix ui
npm run lint --prefix ui
```

For normal desktop development, run from the repo root instead:

```bash
npm run electron-dev
```

That starts Vite, Electron, the local Qalatra API, MCP, and the terminal bridge together.

## File Map

- `src/apiRuntime.ts` stores server selection, token-authenticated HTTP helpers, local Electron server control, and server event streaming.
- `src/api.ts` exports product-level API functions for tasks, settings, files, attachments, habits, heartbeats, backups, and MCP config.
- `src/components/settings/` keeps each Settings tab in its own component.
- `src/mdpdf/` contains the Markdown/editor/PDF preview surface.

Keep new UI data access on the HTTP API path. Electron IPC should stay limited to desktop shell capabilities such as terminal, updater, file-open events, and local server/service management.
