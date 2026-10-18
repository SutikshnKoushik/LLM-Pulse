# LLM Pulse — AI Usage Intelligence

> **Personalized workspace:** new installs open in dark mode and English, with a restrained glass treatment, searchable command palette (`Ctrl+K` / `Cmd+K`), Focus Mode, Compact Layout, and Reduced Motion controls. Theme and workspace preferences are stored locally in this browser profile.

Local-first AI usage intelligence for quota windows, token history, account connections, and cost estimates across Codex, OpenCode, GitHub Copilot CLI, Claude Code, Gemini, Ollama, OpenAI, and Anthropic.

The app is intentionally simple: a Node.js/Express backend serves a vanilla HTML/CSS/JavaScript frontend. Electron packages the same local dashboard as a desktop app, and Docker is available for server-style installs.

Project repository: [SutikshnKoushik/LLM-Pulse](https://github.com/SutikshnKoushik/LLM-Pulse/) · Maintainer profile: [SutikshnKoushik](https://github.com/SutikshnKoushik).

LLM Pulse is a personalized continuation of the MIT-licensed **LLM Usage Dashboard** by [Gerhard Kollinger](https://github.com/kollinger). The upstream project and its copyright notice remain credited in this repository. LLM Pulse is not affiliated with, endorsed by, or sponsored by OpenAI, Anthropic, Google, Gemini, Ollama, or the maintainers of their tools and APIs.

## Features

- Codex local token usage from `~/.codex/sessions` and `~/.codex/archived_sessions`.
- Codex Spark / research quota detection from Codex `token_count` events when available.
- Local GPT account registry across Codex and OpenCode profiles, including previously seen accounts and a manual re-scan after account changes.
- OpenCode OpenAI/GPT token usage from local message metadata without reading prompt or response text.
- GitHub Copilot CLI session metrics from local shutdown events, without reading prompt/response content into dashboard output.
- Claude Code local transcript token usage from `~/.claude/projects`.
- Claude Code plan limit capture from a statusline JSON file when Claude exposes those values.
- Change-only quota history for provider limit windows, stored locally without raw provider payloads.
- Quota integrity diagnostics for unusual quota rollbacks, early reset-deadline shifts, stale Codex snapshots, and local collector gaps.
- Gemini local usage metadata from known local Gemini telemetry/chat paths when present.
- Ollama local token capture through the optional built-in proxy logger.
- Optional OpenAI and Anthropic admin API usage/cost aggregation when admin keys are provided.
- Token history chart with per-provider color stacking, source totals, and API price comparison estimates for local/non-API usage.
- Multilingual UI with system-language detection and a settings language selector.
- Optional password login and OIDC/SSO.
- Electron builds for macOS, Linux AppImage, and Windows.

See [Contributing](CONTRIBUTING.md) for development, privacy, and verification
guidance.

## Personalization and attribution

The local workspace display name, subtitle, profile URL, and repository URL are
configured in [`public/project-brand.js`](public/project-brand.js). The About
footer links to the LLM Pulse profile and repository while keeping the upstream
maintainer and project links separate.

The package's Electron publishing configuration targets the LLM Pulse GitHub
repository. Historical implementation and release evidence in the changelog
and release notes continues to link to the upstream repository.

## Quick Start

Requirements:

- Node.js 22.12 or newer
- npm

```sh
npm install
npm start
```

Open <http://localhost:4177>.

### Windows PowerShell

From the project folder, run:

```powershell
npm ci
npm start
```

Open `http://localhost:4177` in your browser. To run the complete check suite,
open another PowerShell window in the project folder and run:

```powershell
npm run check
```

By default the dashboard is local-unlocked. Set `DASHBOARD_PASSWORD` if you expose the port beyond your own machine. If `SESSION_SECRET` is unset, the server generates a random one on startup; set a stable value if you want login sessions to survive restarts.

## Desktop App

Current upstream desktop downloads remain available on the [original project's releases page](https://github.com/kollinger/llm-usage-dashboard/releases). LLM Pulse desktop builds use this repository's GitHub Actions and release configuration; signing and notarization are not configured.

The installed desktop app starts at login in the background on supported platforms and keeps the local backend running even when the dashboard window is closed. This lets live quota snapshots continue to sync while the machine is awake and online; development runs with `npm run electron` do not install a login item. macOS and Windows use native login-item APIs; Linux packaged builds write an XDG autostart `.desktop` file.

Run the Electron app in development:

```sh
npm run electron
```

Build desktop packages:

```sh
npm run dist:mac
npm run dist:linux
npm run dist:win
```

Artifacts are written to `dist/`.

- macOS uses the universal DMG/ZIP build.
- Linux uses an AppImage for the build architecture; GitHub-hosted release builds produce x86_64 artifacts.
- Windows uses an x64 NSIS installer and a portable EXE.
- These artifacts contain OS-specific binaries. Renaming extensions is not enough to move between operating systems.

Windows builds can be produced on Windows directly. Cross-building from macOS or Linux may require Wine/Mono; the GitHub Actions workflow uses a native Windows runner for the most reliable Windows artifacts.

Desktop artifacts are generated release outputs and should normally not be committed to Git. Publish them through GitHub Releases or workflow artifacts.

Release builds are created by GitHub Actions when a `v*` tag is pushed. For example:

```sh
git tag v1.0.0
git push origin v1.0.0
```

Version numbers follow Semantic Versioning:

- `PATCH` for bug fixes and small non-breaking corrections: `v1.0.0` -> `v1.0.1`
- `MINOR` for new backward-compatible features: `v1.0.0` -> `v1.1.0`
- `MAJOR` for breaking changes: `v1.0.0` -> `v2.0.0`
- Preview builds should use SemVer prerelease tags such as `v1.1.0-preview.1` or `v1.1.0-rc.1`

The workflow builds macOS, Linux, and Windows packages on native GitHub-hosted runners, uploads them as workflow artifacts, and attaches them to a GitHub Release. Release artifacts are currently unsigned prereleases; macOS Gatekeeper and Windows SmartScreen may warn until code signing/notarization certificates are configured as repository secrets.

## Docker

Docker mounts the host's local tool folders read-only and persists dashboard-generated data in `./data`:

```sh
cp .env.docker.example .env
docker compose up --build
```

Open <http://localhost:4177>.

The default Compose file expects:

```text
~/.codex
~/.copilot
~/.claude
~/.gemini
~/.local/share/opencode
```

Inside the container those folders are mounted as:

```text
/host/codex
/host/copilot
/host/claude
/host/gemini
/host/opencode
```

For Ollama on the Linux host, Compose maps `host.docker.internal` and uses:

```text
OLLAMA_HOST=http://host.docker.internal:11434
```

### Multi-Source Discovery (Phase 3)

The dashboard now groups local usage inputs as **sources**. Discovery results are evaluated in
`/api/sources/diagnostics` and exposed in the **Settings → Local sources** view.

The diagnostics endpoint evaluates:

- currently detected candidates from local paths, process hints, and service signals (Linux only),
- already connected sources persisted in `connected-sources.json`,
- per-source access state (`readable`, `missing`, `denied`, `mixed`),
- and summary counters for quick health checks.

The endpoint is usually called as an authenticated background refresh in the UI, but it can also
be used directly for manual diagnostics:

```sh
curl -H "Cookie: <your-session-cookie>" http://localhost:4177/api/sources/diagnostics
```

If a candidate belongs to another local user and direct read access is missing, the UI offers generated
`setfacl` commands for Linux so you can grant and revoke access for the dashboard process owner.
Typical generated lines are:

```text
sudo setfacl -m u:<dashboard-user>:--x <path>
sudo setfacl -R -m u:<dashboard-user>:rX <path>
sudo find <path> -type d -exec setfacl -d -m u:<dashboard-user>:rX {} +
```

Those commands are copied from the app so you can run them manually and then recheck source access.

## Configuration

Copy one of the example files when you need local configuration:

```sh
cp .env.example .env
```

Important variables:

```text
PORT=4177
DASHBOARD_PASSWORD=
LLM_USAGE_DATA_DIR=
DATA_DIR=
SESSION_SECRET=
CODEX_HOME=~/.codex
LLM_USAGE_CODEX_HOMES=
CODEX_LIVE_RATE_LIMITS=true
CODEX_LIVE_RATE_LIMITS_CACHE_SECONDS=15
LLM_USAGE_OPENCODE_DATA_DIRS=
LLM_USAGE_OPENCODE_DB_FILES=
LLM_USAGE_OPENCODE_AUTH_FILES=
COPILOT_HOME=~/.copilot
CLAUDE_HOME=~/.claude
GEMINI_HOME=~/.gemini
OLLAMA_HOST=http://localhost:11434
OLLAMA_PROXY_PORT=11435
OPENAI_ADMIN_KEY=
ANTHROPIC_ADMIN_KEY=
ANTHROPIC_WORKSPACE_ID=
ANTHROPIC_API_CACHE_SECONDS=60
```

OIDC/SSO is optional:

```text
OIDC_ISSUER_URL=
OIDC_CLIENT_ID=
OIDC_CLIENT_SECRET=
OIDC_REDIRECT_URI=http://localhost:4177/auth/oidc/callback
OIDC_SCOPE=openid profile email
```

Never commit `.env` files with real secrets.

## Quota Integrity Diagnostics

The **Quota integrity** panel, the `diagnose:quota` command and the authenticated `GET /api/quota-integrity?sinceHours=168` endpoint look for unusual changes in recorded quota metadata and for gaps in live Codex quota collection (weekly, monthly and other window types). They are designed to help investigate reports such as an unexpected remaining-quota drop or a moving reset deadline. Results separate **measured facts**, **estimates** and **hypotheses**; an unusual observation is not proof of a provider-side defect, and local token totals are not an exact conversion of subscription quota.

```powershell
npm run diagnose:quota
npm run diagnose:quota -- --since-hours 168 --out .\quota-integrity-report.txt
npm run diagnose:quota -- --json --since-hours 168 --out .\quota-integrity-report.json
# Installed Windows app: it keeps its data under %APPDATA% and ignores DATA_DIR
npm run diagnose:quota -- --data-dir "$env:APPDATA\LLM Usage Dashboard\data"
```

`npm start` (source mode) stores data in `.\data` next to `server.js`; the installed app stores it in `%APPDATA%\LLM Usage Dashboard\data`. A report is only meaningful if it reads the folder the dashboard is actually writing to, so [the Windows section](docs/quota-integrity.md#windows-powershell) shows how to verify the live folder and how to collect a seven-day report. Share only the generated report, never authentication files, raw session logs or the data folder.

The CLI defaults to the last seven days; use `--all-history` to inspect everything recorded. It reads only the dashboard's local `quota-events.jsonl`, `codex-reset-snapshots.jsonl` and `token-activity.jsonl` metadata (the last holds token counters per five-minute slot, nothing else). It never needs prompt text, transcripts, provider credentials or token files. See [Quota Integrity Diagnostics](docs/quota-integrity.md) for what is detected, how usage rises are compared with local activity, Windows setup, privacy details and interpretation limits.
