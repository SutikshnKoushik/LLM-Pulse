import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const script = path.join(root, "scripts", "quota-integrity-report.mjs");
const tempRoot = await mkdtemp(path.join(tmpdir(), "quota integrity cli "));
const run = (...args) => execFileSync(process.execPath, [script, ...args], { encoding: "utf8" });

try {
  // A path with spaces, like %APPDATA%\LLM Usage Dashboard\data.
  const dataDir = path.join(tempRoot, "LLM Usage Dashboard", "data");
  const reportFile = path.join(tempRoot, "reports", "report.json");
  await mkdir(dataDir, { recursive: true });
  const now = Date.now();
  const iso = (offset) => new Date(now + offset * 60_000).toISOString();
  const reset = iso(5 * 60 * 24);
  const rows = [
    { type: "quota_window", provider: "codex", windowKey: "weekly", capturedAt: iso(-2), usedPercent: 18, resetsAt: reset },
    { type: "quota_window", provider: "codex", windowKey: "weekly", capturedAt: iso(-1), usedPercent: 12, resetsAt: reset, prompt: "private content", accessToken: "private credential" }
  ];
  const snapshots = [];
  // 95 % for a day, then 97 % observed 40 minutes ago; local logs were scanned a minute ago and show nothing since.
  for (let m = 1500; m >= 1; m--) snapshots.push({ kind: "sample", source: "live", at: iso(-m), accountKey: "hashed-account", window: { usedPercent: m > 40 ? 95 : 97, resetsAt: reset, windowMinutes: 10080 } });
  const activity = [{ kind: "scan", group: "codex", at: iso(-1), eventCount: 5, firstEventAt: iso(-5000), lastEventAt: iso(-4000) }];
  const lines = (list) => list.map((row) => JSON.stringify(row)).join("\r\n") + "\r\n"; // CRLF, like a Windows-edited file
  await writeFile(path.join(dataDir, "quota-events.jsonl"), lines(rows));
  await writeFile(path.join(dataDir, "codex-reset-snapshots.jsonl"), lines(snapshots));
  await writeFile(path.join(dataDir, "token-activity.jsonl"), lines(activity));

  // JSON output to a file in a directory that does not exist yet.
  const printed = execFileSync(process.execPath, [script, "--json", "--data-dir", dataDir, "--out", path.join("reports", "report.json")], { encoding: "utf8", cwd: tempRoot });
  assert.match(printed, /Wrote quota integrity report to reports/);
  assert.ok(!printed.includes(tempRoot), "the console message echoes a relative path as typed, not an expanded absolute path");
  const report = JSON.parse(await readFile(reportFile, "utf8"));
  assert.equal(report.schemaVersion, 2);
  assert.ok(report.anomalies.some((entry) => entry.type === "usage_rolled_back"));
  assert.ok(report.anomalies.some((entry) => entry.type === "usage_increase_without_local_activity"));
  const output = JSON.stringify(report);
  for (const secret of ["private content", "private credential", "hashed-account", tempRoot]) assert.ok(!output.includes(secret), `leaked ${secret}`);

  // Text output keeps measured facts, estimates and hypotheses apart and never prints local paths.
  const text = run("--data-dir", dataDir);
  assert.match(text, /Quota Integrity Report/);
  assert.match(text, /Data coverage \(measured\)/);
  assert.match(text, /Hypotheses, not findings:/);
  assert.match(text, /not proof of provider-side defects/);
  assert.match(text, /change[s]? only|records changes only/);
  assert.ok(!text.includes(tempRoot));

  // A narrow range and --all-history both work; invalid arguments fail clearly with a non-zero exit.
  assert.match(run("--since-hours", "1", "--data-dir", dataDir), /Range: since /);
  assert.match(run("--all-history", "--data-dir", dataDir), /Range: all recorded history/);
  const bad = spawnSync(process.execPath, [script, "--since-hours", "0"], { encoding: "utf8" });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /--since-hours must be between/);
  const unknown = spawnSync(process.execPath, [script, "--nope"], { encoding: "utf8" });
  assert.notEqual(unknown.status, 0);

  // An empty or missing data directory is explained, not a crash.
  const empty = spawnSync(process.execPath, [script, "--data-dir", path.join(tempRoot, "nothing here")], { encoding: "utf8" });
  assert.equal(empty.status, 0);
  assert.match(empty.stderr, /No quota history files were found/);
  assert.match(empty.stdout, /insufficient_data/);

  // Where the data came from is stated on stderr only. The report itself never mentions it and never contains a path.
  const noteFor = (args, env) => spawnSync(process.execPath, [script, "--since-hours", "1", ...args], { encoding: "utf8", env: { ...process.env, LLM_USAGE_DATA_DIR: "", DATA_DIR: "", ...env } });
  const viaArgument = noteFor(["--data-dir", dataDir], {});
  assert.match(viaArgument.stderr, /Data directory source: --data-dir argument\./);
  assert.ok(!viaArgument.stdout.includes("Data directory source") && !viaArgument.stdout.includes(tempRoot), "the report text carries no source note and no path");
  assert.ok(!viaArgument.stderr.includes(tempRoot), "stderr does not echo the folder either");
  assert.match(noteFor([], { LLM_USAGE_DATA_DIR: dataDir }).stderr, /Data directory source: LLM_USAGE_DATA_DIR environment variable\./);
  const viaDataDir = noteFor([], { DATA_DIR: dataDir });
  assert.match(viaDataDir.stderr, /Data directory source: DATA_DIR environment variable \(the installed app ignores this one\)\./);
  assert.match(viaDataDir.stdout, /Quota Integrity Report/, "DATA_DIR still works for source mode");
  assert.equal(noteFor(["--data-dir", dataDir, "--json"], {}).stdout.includes("Data directory source"), false);
  assert.match(noteFor([], {}).stderr, /Data directory source: project default \(the data folder next to server\.js; source mode only\)\./);
  // The report states how fresh the collector is, which is how a user can tell they are reading the live folder.
  assert.match(text, /Codex collector: live; last live sample: \d{4}-\d\d-\d\dT[\d:.]+Z; age: \d+(\.\d+)? minutes/);
  const staleFolder = path.join(tempRoot, "not the live folder");
  await mkdir(staleFolder, { recursive: true });
  const wrong = spawnSync(process.execPath, [script, "--data-dir", staleFolder], { encoding: "utf8" });
  assert.match(wrong.stdout, /Codex collector: no_data/, "pointing at a folder the app is not writing to is visible in the report itself");
  assert.match(wrong.stdout, /insufficient_data/);

  // The CLI needs only Node.js: copy just its own files into an empty folder (no node_modules anywhere) and run it.
  const bare = path.join(tempRoot, "bare copy");
  await mkdir(path.join(bare, "scripts"), { recursive: true });
  await mkdir(path.join(bare, "lib"), { recursive: true });
  const { copyFile } = await import("node:fs/promises");
  await copyFile(script, path.join(bare, "scripts", "quota-integrity-report.mjs"));
  for (const name of ["quota-integrity.js", "quota-integrity-data.js", "token-activity.js", "usage-events.js", "codex-reset-history.js"]) await copyFile(path.join(root, "lib", name), path.join(bare, "lib", name));
  const bareRun = spawnSync(process.execPath, [path.join(bare, "scripts", "quota-integrity-report.mjs"), "--data-dir", dataDir], { encoding: "utf8", cwd: bare, env: { ...process.env, NODE_PATH: "" } });
  assert.equal(bareRun.status, 0, bareRun.stderr);
  assert.match(bareRun.stdout, /Hypotheses, not findings:/, "the full report works without npm install");

  // A Go plan reports one 30-day window and no weekly window: the report must say so, and must not call it weekly.
  const goDir = path.join(tempRoot, "go plan data");
  await mkdir(goDir, { recursive: true });
  const goRows = [{ kind: "gap", at: iso(-120), status: "unavailable", reason: "no_account_id" }, { kind: "gap", at: iso(-115), status: "unavailable", reason: "no_account_id" }, { kind: "gap", at: iso(-110), status: "unavailable", reason: "no_quota_window" }];
  for (let m = 100; m >= 1; m--) goRows.push({ kind: "sample", source: "live", at: iso(-m), accountKey: "go-hash", planType: "go", window: { usedPercent: 37, resetsAt: iso(20 * 24 * 60), windowMinutes: 43200 } });
  await writeFile(path.join(goDir, "codex-reset-snapshots.jsonl"), goRows.map((row) => JSON.stringify(row)).join("\r\n") + "\r\n");
  const goText = run("--data-dir", goDir);
  assert.match(goText, /Codex live quota snapshots: 100 \(window types: window_43200m \(30d\); weekly: 0\)/, "all live snapshots are counted, the weekly count is separate");
  assert.ok(!/Codex weekly live snapshots/.test(goText), "the old weekly-only wording is gone");
  assert.match(goText, /Codex collector: live;/);
  assert.match(goText, /codex\/window_43200m \(30d\): collector unavailable for [\d.]+ minutes, 3 failure record\(s\); reasons: the response had no account identifier, so the snapshot cannot be tied to an account \(2\), the response had no complete quota window \(1\)\./, "why the collector failed is stated");
  const goJson = JSON.parse(run("--data-dir", goDir, "--json"));
  assert.equal(goJson.coverage.codexLiveSamples, 100);
  assert.equal(goJson.coverage.codexWeeklySamples, 0);
  assert.deepEqual(goJson.gaps[0].failureReasons, { no_account_id: 2, no_quota_window: 1 });
  assert.ok(!JSON.stringify(goJson).includes("go-hash") && !JSON.stringify(goJson).includes("go plan data"));

  // --help documents the Windows data directory.
  assert.match(run("--help"), /%APPDATA%/);

  console.log("Quota integrity CLI: Windows-style paths, CRLF files, text/JSON output, correlation, arguments and privacy passed.");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
