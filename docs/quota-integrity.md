# Quota integrity diagnostics

The quota integrity tool complements the dashboard's multi-provider usage and quota history. It helps tell an *unusual quota observation* apart from a *confirmed provider defect*. It never claims the second from the first.

It is available three ways, all backed by the same analyzer (`lib/quota-integrity.js`):

- the **Quota integrity** panel in the dashboard,
- the authenticated endpoint `GET /api/quota-integrity?sinceHours=168`,
- the command line: `npm run diagnose:quota`.

## Three kinds of statements, never mixed

Every result is labelled as one of these, in the panel, the CLI text and the JSON structure:

| Label | Meaning | Examples |
| --- | --- | --- |
| **Measured** | Something the dashboard actually recorded. | Used 95 % → 97 %; reset time moved 38 minutes; 0 local token events in 24 h; 41 failed collection attempts. |
| **Estimate** | Arithmetic on measured values that depends on assumptions. Always low confidence. | Median local tokens per quota percentage point. Only shown when at least 8 comparable steps exist. |
| **Hypothesis** | A candidate explanation. Never a finding, never proof. | Usage on another device, another account sharing the quota, provider-side accounting or adjustment, incomplete local logs. |

Local token totals are **not** an exact conversion of subscription quota. Providers weight models, cached input and plan multipliers differently, and local logs only see activity on this computer.

## What it detects

| Finding | Meaning |
| --- | --- |
| `usage_increase_without_local_activity` | Reported used % rose by at least one point (warning at two or more, high enough confidence) and no local token activity for the provider was recorded since the previous value was first observed. This is the "remaining 5 % became 3 % but I did not use it" case. Needs the local activity ledger (below). |
| `usage_rolled_back` | Used % fell by three or more points while the reset deadline stayed effectively the same. |
| `reset_deadline_changed_early` | The reset deadline moved by ten minutes or more before the previously reported deadline was due. |
| `collector_gap` | The local collector recorded consecutive failures. Repeated failure rows are one incident, measured from the last good sample to recovery. |
| `observation_gap` | No observations at all for more than ten minutes (dashboard closed, computer asleep, collection disabled). Informational. |
| `account_changed` | The live Codex snapshots switched to a different account scope. Values are never compared across accounts. |
| `stale_codex_snapshot` / `no_live_codex_samples` | Live data is older than six minutes, or none exists. |

### Evidence that explains a finding

- **Reset credit redeemed.** If the Codex snapshots show a credit changing to *redeemed* between two observations, a rollback or early reset is downgraded to informational and labelled with the evidence level (`confirmed` or `inferred`). An early reset with no credit used stays a warning, labelled as an inferred provider-side reset.
- **Account switch.** A ledger rollback that straddles an account switch seen in the live snapshots is downgraded and labelled `possible`.
- **Collection gap.** A usage rise whose interval overlaps a gap keeps its measured facts but gets low confidence and informational severity.

### Normal behaviour that is deliberately *not* flagged

- A weekly rollover after the previous deadline has passed.
- An **unused** window: it reports a rolling "now + window" deadline that only becomes fixed on first use, so deadline differences while at 0 % are expected.
- A quiet period in `quota-events.jsonl`. That file records **changes only**, so gaps between its rows do not mean missed polling. Collection gaps are measured from the Codex live snapshots, which are recorded about once a minute.

## How usage rises are compared with local activity

For each rise in reported usage the analyzer looks at local token activity from five minutes before the previous value was first observed until ten minutes after the rise was observed. The lead margin exists because a local token event is logged when a response *finishes*, which can be after the provider already counted the usage. If the previous value began before the loaded history, the start of the quota window is used instead, which counts more activity and can only make an "unexplained" verdict harder to reach.

A step is classified as:

- **Local activity present**: events from the provider's own local logs fall in the interval. This is a positive observation and needs no coverage proof. It is consistent with local use, not a quantitative match.
- **Only another local agent**: for Codex, OpenCode activity (which may use the same ChatGPT subscription) is reported separately and never merged into the Codex count. Codex Spark has its own limit and is never counted.
- **No local activity recorded**: nothing from the provider's own logs, nor from a shared agent that has ever produced activity here.
- **Not assessable**, with a reason: the history starts here, there is no local log history, local logs begin later than the interval, or the logs have not been read recently enough.

"Only another local agent" and "no local activity" are both **absence claims** about the logs. Both are made only when every relevant source is proven to cover the whole interval. Missing, stale, skewed or damaged coverage records always produce *not assessable*, never a warning:

1. **History exists** for every primary group (a scan that saw events, or recorded slots).
2. **History provably begins before the interval.** A scan that lacks its first-event time counts only if recorded slots from before the interval exist.
3. **A scan finished after the interval was complete**, per provider group. A scan only vouches for 5-minute slots that had already closed when it ran, so it must be at or after the *end of the slot containing the end of the ten-minute lookahead*. A fresh scan of another provider never counts, and neither does a scan stamped later than the analysis clock allows (five minutes of skew is tolerated), or one that found no events while slots show history exists.
4. **A shared agent that has ever produced activity here** (OpenCode for Codex) must satisfy rule 3 too, since its usage cannot be excluded otherwise. A shared agent that never produced activity is ignored. If it once did and is no longer being read, Codex verdicts stay *not assessable*.

Scan times are the moment the log reads **began**, not when the result was written, so a scan never claims to have seen events logged while it was still reading. Because the ledger is only refreshed when usage is read and heartbeats are written at most every 15 minutes while nothing changes, a finding can take roughly **15 to 30 minutes** after the observation to appear. Until then it shows as not assessable (logs not re-read yet).

Findings of the "without local activity" kind list hypotheses as codes, shown as *possible explanations (hypotheses, not findings)*.

Quota records dated after the analysis clock (for example written while the system clock was wrong) are ignored and counted (`coverage.futureDatedRecords`, shown in the CLI text). Left in, one such record would make a stopped collector look live or fake a later "rollback".

## Local token activity ledger

To compare quota changes with local activity over days instead of 24 hours, the dashboard keeps `token-activity.jsonl` in its data directory. It stores **counters only**, per provider group and five-minute slot: event count and token totals, plus a scan heartbeat (event count and first/last event time). It never stores prompts, transcripts, model names, file paths, session ids, account identifiers or raw provider payloads, and the file is created with owner-only permissions where the platform supports it.

- It is written whenever usage is read (dashboard open, or device sync enabled) and backfills from the provider's own logs up to 35 days.
- A slot only ever grows: if a provider later rotates or deletes its own logs, activity already recorded is not lost.
- It is compacted automatically when it exceeds 4 MB.
- Only fixed provider groups (`codex`, `codexSpark`, `openCode`, `copilot`, `claudeCode`, `gemini`, `glm`, `kimi`, `ollama`) can be written or read back. Group names never come from log content, a paired device or an account, and an unknown name is rejected.
- Provider logs are untrusted JSON. The shared usage normalizer would turn `true` into 1 and `[900]` into 900, so counters are validated before they are aggregated: an event with a malformed counter still counts as activity (something happened then) but adds no tokens, which can only make an absence claim harder, never easier. Stored records are validated again on read (wrong types, absurd magnitudes, array or boolean timestamps and unexpected fields are rejected or dropped).
- It is not written when the dashboard is not running or the UI is closed with device sync disabled; findings for such periods show as "not assessable" until the next read.

## Privacy

Reports use only quota metadata already captured by this dashboard plus the counters above. Nothing in the API, panel or CLI output contains credentials, access tokens, account identifiers (hashes included), prompts, transcripts, local absolute paths or raw provider payloads. Credit keys are used internally to detect redemption and are never emitted. Keep `data/` and generated reports out of Git; `data/` is already ignored.

## Windows PowerShell

There are two ways to run the dashboard. They keep their data in **different folders**, and a report is only meaningful if it reads the folder the dashboard is actually writing to.

| How you run it | Data folder the dashboard uses |
| --- | --- |
| **Source mode**: `npm start` in the extracted project folder | `<project folder>\data` (that is, `.\data`), unless `LLM_USAGE_DATA_DIR` or `DATA_DIR` was set in the PowerShell window where you ran `npm start`. |
| **Installed Electron app** | `%APPDATA%\LLM Usage Dashboard\data`, unless a Windows user environment variable `LLM_USAGE_DATA_DIR` is set (then that folder). The installed app **ignores `DATA_DIR`**. |

Running from source needs `npm ci` once. The report command needs **only Node.js 22.12 or newer and the project folder**, with no `npm ci`, so it also works next to an installed app.

### Collect a seven-day report

**1. Find the folder the dashboard is really using.** With the dashboard running and Codex signed in, run this from the project folder. It lists the candidate folders and how recently each last had a Codex snapshot written (about one per minute):

```powershell
$candidates = @((Join-Path (Get-Location) 'data'), (Join-Path $env:APPDATA 'LLM Usage Dashboard\data'))
if ($env:LLM_USAGE_DATA_DIR) { $candidates += $env:LLM_USAGE_DATA_DIR }
if ($env:DATA_DIR) { $candidates += $env:DATA_DIR }
foreach ($dir in ($candidates | Select-Object -Unique)) {
  $file = Join-Path $dir 'codex-reset-snapshots.jsonl'
  if (Test-Path -LiteralPath $file) {
    $age = [int]((Get-Date) - (Get-Item -LiteralPath $file).LastWriteTime).TotalSeconds
    '{0,8} s ago   {1}' -f $age, $dir
  } else { '  no file      {0}' -f $dir }
}
```

The folder showing a small number (seconds to a couple of minutes) is the live one. If none does, the dashboard is not recording Codex snapshots yet (check that Codex is signed in and live rate-limit collection is enabled) and there is nothing to report on. `LLM_USAGE_DATA_DIR` and `DATA_DIR` only matter if they were set in the environment the dashboard was started from; the listing includes them only if they are set in *this* window.

**2. Let the dashboard run for seven days** with Codex signed in. Time with the app closed or the computer asleep shows up as *no observations*.

**3. Generate the report from exactly that folder.** Always pass `--data-dir` explicitly so there is no doubt which folder is read. Run from the project folder:

```powershell
# Installed app (default location):
$dataDir = Join-Path $env:APPDATA 'LLM Usage Dashboard\data'
# Source mode (npm start) instead:
# $dataDir = Join-Path (Get-Location) 'data'
# Or whatever folder step 1 showed as live.

node scripts\quota-integrity-report.mjs --data-dir $dataDir --since-hours 168 --out .\quota-integrity-report.txt
node scripts\quota-integrity-report.mjs --data-dir $dataDir --since-hours 168 --json --out .\quota-integrity-report.json
```

(`npm run diagnose:quota -- --data-dir $dataDir --since-hours 168 --out .\quota-integrity-report.txt` is equivalent in source mode.) The CLI prints where the folder came from (not the path) on the console, and warns if the installed app's folder holds newer history than the one being read.

**4. Check the report before sharing it.** Open `quota-integrity-report.txt`:

- `Codex collector:` should say `live` (or show a last live sample within the period the app was running), and `Codex live quota snapshots` should be large (roughly one per minute the app ran). A Go plan shows `window types: window_43200m (30d); weekly: 0`, which is normal. `no_data`, zero snapshots or `insufficient_data` means the wrong folder was read: **do not share the report; repeat step 1.**
- Findings of the kind *usage rose without local activity* only appear once the local activity records cover the interval; otherwise the step is listed as not assessable. That is expected for the most recent 15 to 30 minutes.

**5. What to share, and what never to.** Share only `quota-integrity-report.txt` (and optionally the `.json`), after reading it yourself. Reports contain quota percentages, reset times, counts, token totals and coarse timestamps, and by design no credentials, account identifiers, prompts, transcripts or local paths.

**Never upload, attach or paste:**

- authentication files, such as Codex's `auth.json` or anything inside your `.codex` folder, or any token, cookie or API key,
- raw session logs, such as the Codex `sessions` folder and its `rollout-*.jsonl` files, or any chat/transcript export,
- the dashboard's data folder or its `.jsonl` / `.json` files (the raw history files, not the report),
- screenshots or terminal output that show tokens, e-mail addresses, account names or folder paths. The console warnings about a competing data folder include a path, so do not paste those.

### Windows details

Paths with spaces must be quoted or held in a variable as above. Files edited or re-saved by Windows tools (CRLF line endings, a UTF-8 byte order mark) are read correctly; a UTF-16 file (for example from `Out-File` without `-Encoding utf8`) is not, and will be reported as having no history. The server expands `~` and `~/` but not `~\` in data folder settings, and the report command follows the same rule.

The default range is seven days. `--all-history` analyzes everything recorded and can use a lot of memory on years of data.

## Interpretation limits

- An anomaly is an observation to investigate, not proof of a bug. Providers may change quotas after a credit redemption, subscription change, account switch or server-side adjustment.
- Local logs cover this computer only. Use on another device, the web app, an IDE extension, cloud tasks or another account sharing the quota is invisible to them, and would look identical to "unexplained" usage.
- The quota event ledger (`quota-events.jsonl`) is not account-scoped, so findings from it are labelled lower confidence. The Codex live snapshots are account-scoped.
- Quota percentages are reported by the provider and may be rounded. A one-point step can reflect fractional accumulation.
- History begins when the dashboard first recorded observations and cannot be reconstructed afterwards. If there are no valid live Codex samples, check that Codex is signed in, that the dashboard can reach the local Codex app-server, and that `CODEX_LIVE_RATE_LIMITS` is not disabled.
- The ledger only knows about log sources the dashboard reads. If a shared agent (for example OpenCode) once produced activity here but its logs are no longer being read, Codex verdicts stay *not assessable* rather than guessing that it did not run.
- A one-minute collection gap is not detectable in `quota-events.jsonl`, which records changes only. Use the Codex live snapshots for gap measurement.
- Compare any finding with the provider's own current quota display, note the exact time, and repeat measurements before concluding that accounting is wrong.


### Live window types (Go plan and others)

Codex live snapshots describe different windows depending on the plan: a weekly window (10,080 minutes), a five-hour window, or, for example, the single **30-day (43,200-minute) window a Go plan reports** with no weekly window at all. This was confirmed on Codex CLI 0.162.1 (`plan: go`, one primary window, no secondary). Earlier versions of the collector only accepted a weekly window, treated a perfectly good Go response as a failure and recorded repeated collection gaps. That was a local compatibility bug, not evidence of anything on the provider's side.

- **What is recorded.** One window per snapshot: the weekly window if the response has one, otherwise the *longest* complete bounded window (up to one year), whatever order the response lists them in. A response with any supported window is a success and never produces a failure record. An account that reports **both** a weekly and a monthly window is therefore recorded as weekly only; its monthly window is not recorded.
- **Why a failure happened.** Failure records carry one fixed reason: `request_failed`, `malformed_response`, `no_quota_window` (no complete, numeric, bounded window) or `no_account_id` (a usable window, but the response carries no account identifier, so the snapshot cannot be tied to an account). The report states the counts per incident. No response content is ever stored with them.
- **Window names.** The same as the quota ledger: `five_hour`, `weekly`, `window_<minutes>m`. A 30-day window is `window_43200m`, shown as `(30d)`.
- **Independent series.** Every account and window name is its own series. Values, reset times, usage steps and reset-credit attribution are never compared across window types or across accounts, and an account changing window type (for example after a plan change) starts a new series rather than showing a drop.
- **Counters and the weekly views.** `codexLiveSamples` counts every live snapshot; `codexWeeklySamples` counts weekly ones only. The panel chart and the weekly reset-history view are weekly by design and stay empty for a monthly-only account, while the observations metric, the window list and the findings reflect the monthly window. The reset-history panel's *recording* status counts a live sample of any window.
- **Long windows and local activity.** The activity records loaded reach back 36 days so a 30-day window is covered, and no absence claim reaches back before the ledger's 35-day retention (or before what the reader loaded): such steps are *not assessable*.
