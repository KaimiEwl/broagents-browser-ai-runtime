# BROAGENTS Browser AI Runtime

![Project preview](docs/screenshots/preview.png)

A local control center for coordinating AI browser tabs as role-based agents.

## Demo

- GitHub: https://github.com/KaimiEwl/broagents-browser-ai-runtime
- Live demo: not applicable for this project type
- Video: planned
- Case notes: see `docs/architecture.md`

## What it shows

This project shows AI tooling, browser automation architecture, WebSocket coordination, Chrome extension packaging and operator-focused UX.

## Features

- Local HTTP/WebSocket server
- Chrome extension for ChatGPT/Gemini tabs
- Dashboard for registered agents
- Role and scenario configuration
- Windows launch/reset scripts

## Tech stack

- Node.js
- WebSocket
- Chrome Extension
- React/Vite
- PowerShell

## Local setup

```
npm install
npm start
```

## Verification

```
node --check server.js
```

## Status

Demo export. Local state, backups and runtime logs are excluded.

## Security and cleanup

This public repository is a clean portfolio export. It intentionally excludes production secrets, local databases, logs, generated media, backups, runtime folders and private deployment artifacts.
