# Contributing

## Project structure

- Backend: Node.js 22+ and Express in `server.js`.
- Frontend: vanilla HTML, CSS, and JavaScript in `public/`.
- Desktop app: Electron and electron-builder in `electron/` and `package.json`.
- Container runtime: `Dockerfile` and `docker-compose.yml`.

Use the existing architecture and dependencies unless a change needs something
new. Keep changes focused and preserve existing provider integrations and local
data formats.

## Development

Install dependencies and run the dashboard:

```powershell
npm ci
npm start
```

The dashboard listens on `http://localhost:4177` by default. Run the desktop
app in development with `npm run electron`.

Keep frontend layouts responsive and keyboard accessible. User-facing strings
belong in `public/i18n/*.json`. When changing localized strings, update every
supported language file and keep interpolation placeholders consistent. English
is the default and translation fallback.

## Privacy and local data

Do not commit usage data, logs, generated artifacts, installed dependencies, or
secrets. Keep `data/`, `dist/`, `node_modules/`, `.env`, and `.env.*` files out
of Git; checked-in `.env.example` files may contain placeholders only.

Never add credentials, account identifiers, local absolute paths, transcripts,
prompts, raw provider payloads, or raw logs to source control, diagnostics, or
the UI. If adding local state, caches, or logs, update `.gitignore` before
creating those files. Preserve the distinction between measured, calculated,
estimated, and unavailable values. A missing or unreliable measurement must be
shown as unavailable rather than as zero.

## Checks

Run the complete project check suite before proposing a code change:

```powershell
npm run check
```

For container-impacting changes, rebuild the image:

```powershell
docker build -t llm-usage-dashboard:local .
```

Changes to startup, networking, authentication, data paths, provider
integrations, or packaging should also be smoke-tested in the relevant runtime.
Package outputs belong in `dist/` and should not be committed.
