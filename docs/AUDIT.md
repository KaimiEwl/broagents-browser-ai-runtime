# BROAGENTS Audit

## Checked

- The package contains the runtime server, built dashboard, Chrome extension, data folder, and minimal Node dependency `ws`.
- The package now also contains a separate desktop app bundle in `desktop-app/`.
- The package now also contains editable app source in `app-source/`.
- Startup docs and agent behavior settings are included.
- A practical CLI helper `scripts/ensure-agent-start.js` is included.
- Clean-start scripts are included to wipe stale agent snapshots before reuse.

## Risks that were addressed

- Startup script no longer silently trusts any unknown process already using port `8080`.
- The package is no longer tied to the old pilot project for project status snapshots.
- The dashboard is served directly by the local server, so Vite is not required for normal use.
- Reused copies can be started with a clean state via `start-broagents-clean.cmd`.
- Full launch no longer opens both browser and desktop app at the same time.

## Remaining known limits

- Chrome extension is still hard-coded to `ws://localhost:8080`.
- DOM automation against ChatGPT and Gemini can break if those sites change their UI.
- Desktop app is bundled as a ready-made artifact, not rebuilt from source during startup.
