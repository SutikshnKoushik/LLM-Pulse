import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { readQuotaIntegrityInputs, resolveDataDir, competingDataDir, installedAppDataDir, expandHome } = require("../lib/quota-integrity-data.js");
const { analyzeQuotaIntegrity } = require("../lib/quota-integrity.js");
const serverPath = require.resolve("../server.js");

// A directory name with spaces mirrors "%APPDATA%\LLM Usage Dashboard\data" on Windows.
const root = await mkdtemp(path.join(tmpdir(), "quota integrity data "));
const dataDir = path.join(root, "LLM Usage Dashboard", "data");
const now = Date.now();
const iso = (minutes) => new Date(now + minutes * 60_000).toISOString();
const reset = iso(5 * 24 * 60);

try {
  await mkdir(dataDir, { recursive: true });

  {
    // Missing files are not an error: the reader reports that nothing was found.
    const inputs = await readQuotaIntegrityInputs({ dataDir: path.join(root, "does-not-exist"), sinceMs: now - 3_600_000 });
    assert.deepEqual(inputs.stats.filesFound, { quotaEvents: false, snapshots: false, activity: false });
    assert.equal(inputs.quotaEvents.length + inputs.codexSnapshots.length + inputs.activityRecords.length, 0);
    assert.equal(analyzeQuotaIntegrity(inputs).summary.status, "insufficient_data");
  }

  {
    // CRLF line endings, a UTF-8 BOM, blank lines and torn/garbled lines (as left by crashes or editors).
    const rows = [
      { type: "quota_window", provider: "codex", windowKey: "weekly", capturedAt: iso(-30), usedPercent: 50, resetsAt: reset },
      { type: "quota_status", provider: "codex", windowKey: "sync_status", capturedAt: iso(-29), status: "error" },
      { type: "quota_window", provider: "codex", windowKey: "weekly", capturedAt: iso(-20), usedPercent: 40, resetsAt: reset }
    ];
    const text = "\uFEFF" + rows.map((row) => JSON.stringify(row)).join("\r\n") + "\r\n\r\n{\"type\":\"quota_window\",\"prov\r\nnot json at all\r\n";
    await writeFile(path.join(dataDir, "quota-events.jsonl"), text);
    const inputs = await readQuotaIntegrityInputs({ dataDir, sinceMs: now - 3_600_000 });
    assert.equal(inputs.quotaEvents.length, 2, "only quota windows are loaded; the BOM did not hide the first row");
    assert.equal(inputs.stats.malformedLines, 2);
    const report = analyzeQuotaIntegrity({ ...inputs, sinceMs: now - 3_600_000, now });
    assert.ok(report.anomalies.some((entry) => entry.type === "usage_rolled_back"));
  }

  {
    // Rows before the range are loaded only as the newest baseline per window / account, and out-of-range rollbacks are not reported.
    const rows = [
      { type: "quota_window", provider: "codex", windowKey: "five_hour", capturedAt: iso(-3000), usedPercent: 90, resetsAt: iso(-2800) },
      { type: "quota_window", provider: "codex", windowKey: "five_hour", capturedAt: iso(-2000), usedPercent: 40, resetsAt: reset },
      { type: "quota_window", provider: "codex", windowKey: "five_hour", capturedAt: iso(-10), usedPercent: 30, resetsAt: reset },
      { type: "quota_window", provider: "codex", windowKey: "five_hour", capturedAt: "garbage", usedPercent: 30, resetsAt: reset }
    ];
    await writeFile(path.join(dataDir, "quota-events.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const since = now - 60 * 60_000;
    const inputs = await readQuotaIntegrityInputs({ dataDir, sinceMs: since });
    assert.equal(inputs.quotaEvents.length, 2, "one in-range row plus exactly one baseline");
    assert.equal(inputs.stats.unplacedRows, 1);
    const report = analyzeQuotaIntegrity({ ...inputs, sinceMs: since, now });
    assert.equal(report.anomalies.filter((entry) => entry.type === "usage_rolled_back").length, 1, "the 40 -> 30 drop uses the carried-in baseline");
    const all = await readQuotaIntegrityInputs({ dataDir, sinceMs: null });
    assert.equal(all.quotaEvents.length, 4, "all-history keeps everything, including the unplaceable row for the analyzer to count");
  }

  {
    // Snapshots: baseline per account, failure rows only in range, extra in-memory snapshot merged.
    const sample = (minutes, used, accountKey) => ({ kind: "sample", source: "live", at: iso(minutes), accountKey, window: { usedPercent: used, resetsAt: reset, windowMinutes: 10080 } });
    const rows = [sample(-5000, 10, "a"), sample(-4000, 11, "a"), sample(-4000, 70, "b"), { kind: "gap", at: iso(-4500) }, sample(-3, 12, "a"), { kind: "gap", at: iso(-2) }];
    await writeFile(path.join(dataDir, "codex-reset-snapshots.jsonl"), rows.map((row) => JSON.stringify(row)).join("\r\n") + "\r\n");
    const inputs = await readQuotaIntegrityInputs({ dataDir, sinceMs: now - 60 * 60_000, extraSnapshots: [sample(-1, 13, "a")] });
    const samples = inputs.codexSnapshots.filter((row) => row.kind === "sample");
    assert.equal(samples.length, 4, "in-range a, extra a, plus one baseline for each of the two accounts");
    assert.equal(inputs.codexSnapshots.filter((row) => row.kind === "gap").length, 1, "the old failure row is out of range");
  }

  {
    // Activity: counters-only records are loaded further back than quota data; malformed records are dropped.
    const slot = (minutes, extra = {}) => ({ kind: "activity", group: "codex", slotStart: iso(minutes), slotMinutes: 5, events: 1, totalTokens: 10, ...extra });
    const rows = [slot(-40 * 24 * 60), slot(-20 * 24 * 60), slot(-6 * 24 * 60), slot(-5), { kind: "scan", group: "codex", at: iso(-1), eventCount: 2 }, { kind: "activity", group: "bad group", slotStart: iso(-1), slotMinutes: 5, events: 1 }];
    await writeFile(path.join(dataDir, "token-activity.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const inputs = await readQuotaIntegrityInputs({ dataDir, sinceMs: now - 24 * 60 * 60_000 });
    assert.equal(inputs.activityRecords.filter((row) => row.kind === "activity").length, 3, "slots are loaded as far back as the ledger keeps them (a 30-day window starts that far back), older ones are not");
    assert.ok(Math.abs(inputs.stats.activityLoadedFromMs - (Date.now() - 24 * 60 * 60_000 - 36 * 24 * 60 * 60_000)) < 60_000);
    assert.equal(inputs.activityRecords.filter((row) => row.kind === "scan").length, 1);
  }

  {
    // Server-side recorder, run in a child process against this temporary directory only.
    await rm(path.join(dataDir, "token-activity.jsonl"), { force: true });
    const code = `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const path = require('node:path');
      const { _test } = require(${JSON.stringify(serverPath)});
      const now = Date.now();
      const slotBase = Math.floor((now - 60 * 60000) / 300000) * 300000; // events below all share one 5-minute slot, whatever time the test runs
      const ev = (seconds, total) => ({ providerId: 'codex', sourceId: 's', timestampMs: seconds === 'old' ? slotBase - 7200000 : slotBase + seconds * 1000, model: 'private-model',
        usage: { total_tokens: total }, metadata: { sourceGroupId: 'codex' }, evidence: { realpath: 'C:\\\\Users\\\\someone\\\\x.jsonl', sessionId: 'private-session' } });
      (async () => {
        const file = path.join(process.env.LLM_USAGE_DATA_DIR, 'token-activity.jsonl');
        await _test.recordLocalTokenActivity([{ _usageEvents: [ev(10, 1000), ev(20, 500), ev('old', 800)] }]);
        const first = fs.readFileSync(file, 'utf8');
        const firstRows = first.trim().split('\\n').map(JSON.parse);
        assert.ok(Math.abs(Date.parse(firstRows.find((row) => row.kind === 'scan').at) - now) < 5000, 'without an explicit start the heartbeat carries the current time');
        await _test.recordLocalTokenActivity([{ _usageEvents: [ev(10, 1000), ev(20, 500), ev('old', 800)] }]);
        assert.equal(fs.readFileSync(file, 'utf8'), first, 'a second identical pass appends nothing');
        await _test.recordLocalTokenActivity([{ _usageEvents: [ev(10, 1000), ev(20, 500), ev('old', 800), ev(30, 250)] }]);
        const rows = fs.readFileSync(file, 'utf8').trim().split('\\n').map(JSON.parse);
        assert.ok(rows.some((row) => row.kind === 'scan' && row.eventCount === 4), 'new events produce a fresh scan record');
        assert.ok(rows.some((row) => row.kind === 'activity' && row.totalTokens === 1750), 'a grown slot is rewritten with the larger total');
        for (const secret of ['private-model', 'private-session', 'someone', 'realpath']) assert.ok(!JSON.stringify(rows).includes(secret), 'leaked ' + secret);
        if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o077, 0, 'file is private to the user');
        const started = now - 90000;
        await _test.recordLocalTokenActivity([{ _usageEvents: [ev(10, 1000), ev(20, 500), ev('old', 800), ev(30, 250), ev(40, 125)] }], started);
        const after = fs.readFileSync(file, 'utf8').trim().split('\\n').map(JSON.parse);
        const latestScan = after.filter((row) => row.kind === 'scan').at(-1);
        assert.equal(latestScan.at, new Date(started).toISOString(), 'the heartbeat carries the time the reads began, not the later write time');
        console.log('recorder ok');
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `;
    const output = execFileSync(process.execPath, ["-e", code], {
      encoding: "utf8",
      env: { ...process.env, LLM_USAGE_DATA_DIR: dataDir, CODEX_LIVE_RATE_LIMITS: "false", DASHBOARD_PASSWORD: "", OIDC_ISSUER_URL: "" }
    });
    assert.match(output, /recorder ok/);
  }

  {
    // The report must read the folder the dashboard writes to. Canaries: the CLI's rules are compared with the real
    // server and Electron source, so a change there fails this test instead of silently splitting the two.
    const serverSource = await readFile(new URL("../server.js", import.meta.url), "utf8");
    const electronSource = await readFile(new URL("../electron/main.js", import.meta.url), "utf8");
    assert.ok(serverSource.includes('const DATA_DIR = expandHome(process.env.LLM_USAGE_DATA_DIR || process.env.DATA_DIR || path.join(ROOT, "data"));'), "server data-dir precedence changed: update resolveDataDir");
    const serverExpand = serverSource.slice(serverSource.indexOf("function expandHome(value)"), serverSource.indexOf("function expandHome(value)") + 260);
    assert.ok(serverExpand.includes('value === "~"') && serverExpand.includes('value.startsWith("~/")') && !serverExpand.includes("path.sep") && !serverExpand.includes('"~\\\\'), "server home expansion changed: update expandHome");
    assert.ok(electronSource.includes('setDefaultEnv("LLM_USAGE_DATA_DIR", path.join(app.getPath("userData"), "data"))'), "installed app data dir changed: update docs and installedAppDataDir");
    assert.ok(/function setDefaultEnv\(name, value\) \{\s*if \(!process\.env\[name\]\) process\.env\[name\] = value;/.test(electronSource), "the installed app must only default LLM_USAGE_DATA_DIR when unset");
    assert.ok(!electronSource.includes("DATA_DIR") || !/process\.env\.DATA_DIR/.test(electronSource), "the installed app does not read DATA_DIR");
  }

  {
    const home = (await import("node:os")).homedir();
    const sampleRoot = path.join(path.parse(process.cwd()).root, "sample");
    const root = path.join(sampleRoot, "project");
    const cwd = path.join(sampleRoot, "work");
    // Precedence: argument, LLM_USAGE_DATA_DIR, DATA_DIR, project default (exactly the server's order).
    assert.deepEqual(resolveDataDir({ argument: "/a", env: { LLM_USAGE_DATA_DIR: "/b", DATA_DIR: "/c" }, root, cwd }), { dir: path.resolve("/a"), source: "argument" });
    assert.deepEqual(resolveDataDir({ env: { LLM_USAGE_DATA_DIR: "/b", DATA_DIR: "/c" }, root, cwd }), { dir: path.resolve("/b"), source: "LLM_USAGE_DATA_DIR" });
    assert.deepEqual(resolveDataDir({ env: { LLM_USAGE_DATA_DIR: "", DATA_DIR: "/c" }, root, cwd }), { dir: path.resolve("/c"), source: "DATA_DIR" }, "an empty variable counts as unset, like the server's ||");
    assert.deepEqual(resolveDataDir({ env: {}, root, cwd }), { dir: path.join(root, "data"), source: "project_default" });
    // Relative paths resolve against the working directory; "~" and "~/" expand; "~\" is NOT expanded (the server would not).
    assert.equal(resolveDataDir({ argument: path.join("rel", "data"), env: {}, root, cwd }).dir, path.join(cwd, "rel", "data"));
    assert.equal(expandHome("~"), home);
    assert.equal(expandHome("~/quota"), path.join(home, "quota"));
    assert.equal(expandHome("~\\quota"), "~\\quota", "a backslash form is left alone, exactly like server.js");
    assert.equal(expandHome("C:\\Users\\x"), "C:\\Users\\x");
    // The installed app's folder is only known on Windows.
    assert.equal(installedAppDataDir({ env: { APPDATA: "/appdata" }, platform: "linux" }), null);
    assert.equal(installedAppDataDir({ env: {}, platform: "win32" }), null);
    assert.equal(installedAppDataDir({ env: { APPDATA: "/appdata" }, platform: "win32" }), path.join("/appdata", "LLM Usage Dashboard", "data"));
  }

  {
    // Competing-folder warning: only for an implicit choice, only on Windows, only when the installed app's folder is newer.
    const appData = path.join(root, "AppData");
    const installed = path.join(appData, "LLM Usage Dashboard", "data");
    const sourceDir = path.join(root, "project data");
    await mkdir(installed, { recursive: true });
    await mkdir(sourceDir, { recursive: true });
    const env = { APPDATA: appData };
    const stamp = async (dir, secondsAgo) => {
      const file = path.join(dir, "codex-reset-snapshots.jsonl");
      await writeFile(file, "{}\n");
      const when = new Date(Date.now() - secondsAgo * 1000);
      const { utimes } = await import("node:fs/promises");
      await utimes(file, when, when);
    };
    await stamp(installed, 30);
    assert.deepEqual(await competingDataDir({ chosen: sourceDir, source: "project_default", env, platform: "win32" }), { installed }, "source folder has no history, installed app does");
    assert.deepEqual(await competingDataDir({ chosen: sourceDir, source: "DATA_DIR", env, platform: "win32" }), { installed }, "the installed app ignores DATA_DIR, so it is also an implicit choice");
    assert.equal(await competingDataDir({ chosen: sourceDir, source: "argument", env, platform: "win32" }), null, "an explicit --data-dir is never second-guessed");
    assert.equal(await competingDataDir({ chosen: sourceDir, source: "LLM_USAGE_DATA_DIR", env, platform: "win32" }), null, "LLM_USAGE_DATA_DIR is what the apps themselves honor");
    assert.equal(await competingDataDir({ chosen: sourceDir, source: "project_default", env, platform: "linux" }), null, "the installed app is a Windows concept here");
    assert.equal(await competingDataDir({ chosen: installed, source: "DATA_DIR", env, platform: "win32" }), null, "already reading the installed app's folder");
    await stamp(sourceDir, 5);
    assert.equal(await competingDataDir({ chosen: sourceDir, source: "project_default", env, platform: "win32" }), null, "the source-mode folder is the newer one: no warning");
    await stamp(sourceDir, 600);
    assert.deepEqual(await competingDataDir({ chosen: sourceDir, source: "project_default", env, platform: "win32" }), { installed }, "installed app wrote more recently");
    assert.equal(await competingDataDir({ chosen: sourceDir, source: "project_default", env: { APPDATA: path.join(root, "nothing") }, platform: "win32" }), null, "no installed-app folder, no warning");
  }

  {
    // The Windows instructions are followed literally, so their essential promises are pinned.
    const docs = await readFile(new URL("../docs/quota-integrity.md", import.meta.url), "utf8");
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
    const windows = docs.slice(docs.indexOf("## Windows PowerShell"), docs.indexOf("## Interpretation limits"));
    assert.ok(windows.includes("npm start") && windows.includes("`.\\data`") && windows.includes("%APPDATA%\\LLM Usage Dashboard\\data"), "both data folders are named");
    assert.ok(/installed app \*\*ignores `DATA_DIR`\*\*/.test(windows), "DATA_DIR does not apply to the installed app");
    assert.ok(windows.includes("codex-reset-snapshots.jsonl") && windows.includes("--since-hours 168") && windows.includes("--data-dir $dataDir"), "verify-then-report procedure with an explicit data folder");
    assert.ok(/do not share the report; repeat step 1/i.test(windows), "a wrong-folder report must not be shared");
    const never = windows.slice(windows.indexOf("**Never upload, attach or paste:**"));
    for (const item of ["auth.json", ".codex", "rollout-*.jsonl", "sessions", "data folder", "tokens"]) assert.ok(never.includes(item), `never-share list mentions ${item}`);
    assert.ok(!/--data-dir\s+"?\$env:APPDATA[^\n]*\n[^\n]*source mode/i.test(windows), "no instruction points source mode at the installed app's folder");
    assert.ok(readme.includes("`npm start` (source mode) stores data in `.\\data`") && readme.includes("never authentication files, raw session logs or the data folder"), "README repeats the distinction and the exclusions");
    assert.ok(docs.includes("always produce *not assessable*, never a warning"), "coverage promise is documented");
  }

  {
    // Reader + analyzer end to end for windows longer than a week. Both were false "no local activity" warnings before:
    // the reader loaded only 8 days of activity, and the ledger keeps only 35 days.
    const DAY = 24 * 60;
    const goDir = path.join(root, "go plan data");
    await mkdir(goDir, { recursive: true });
    const write = (name, rows) => writeFile(path.join(goDir, name), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const sinceMs = now - 7 * DAY * 60_000;
    // A 30-day window that began 25 days ago; a 2-point rise two days ago; real local activity 20 days ago (inside the window).
    const rows = [];
    for (let m = 7 * DAY; m >= 1; m--) rows.push({ kind: "sample", source: "live", at: iso(-m), accountKey: "a", window: { usedPercent: m > 2 * DAY ? 40 : 42, resetsAt: iso(5 * DAY), windowMinutes: 43200 } });
    await write("codex-reset-snapshots.jsonl", rows);
    await write("token-activity.jsonl", [
      { kind: "scan", group: "codex", at: iso(-1), eventCount: 50, firstEventAt: iso(-30 * DAY), lastEventAt: iso(-20 * DAY) },
      { kind: "activity", group: "codex", slotStart: iso(-20 * DAY), slotMinutes: 5, events: 4, totalTokens: 80000, recordedAt: iso(-1) }
    ]);
    const inputs = await readQuotaIntegrityInputs({ dataDir: goDir, sinceMs });
    assert.equal(inputs.activityRecords.filter((row) => row.kind === "activity").length, 1, "activity 20 days back is loaded for a range of 7 days");
    const found = analyzeQuotaIntegrity({ now, sinceMs, ...inputs, activityLoadedFromMs: inputs.stats.activityLoadedFromMs });
    const step = found.steps.find((entry) => entry.deltaPercent === 2);
    assert.equal(step.windowKey, "window_43200m");
    assert.equal(step.local.status, "activity_present", "the activity inside the 30-day window is found");
    assert.ok(!found.anomalies.some((entry) => entry.type === "usage_increase_without_local_activity"), "no false 'no local activity' warning");
    // Same data, activity moved outside the window: now it genuinely is absent and covered, so the finding appears.
    await write("token-activity.jsonl", [
      { kind: "scan", group: "codex", at: iso(-1), eventCount: 50, firstEventAt: iso(-33 * DAY), lastEventAt: iso(-27 * DAY) },
      { kind: "activity", group: "codex", slotStart: iso(-27 * DAY), slotMinutes: 5, events: 4, totalTokens: 80000, recordedAt: iso(-1) }
    ]);
    const outside = await readQuotaIntegrityInputs({ dataDir: goDir, sinceMs });
    const reported = analyzeQuotaIntegrity({ now, sinceMs, ...outside, activityLoadedFromMs: outside.stats.activityLoadedFromMs });
    assert.equal(reported.anomalies.find((entry) => entry.type === "usage_increase_without_local_activity")?.windowKey, "window_43200m");

    // --all-history over steps older than the ledger's retention: not assessable, never an absence claim.
    const old = [];
    for (let m = 80 * DAY; m >= 50 * DAY; m -= 5) old.push({ kind: "sample", source: "live", at: iso(-m), accountKey: "a", window: { usedPercent: m > 70 * DAY ? 10 : 12, resetsAt: iso(-45 * DAY), windowMinutes: 10080 } });
    await write("codex-reset-snapshots.jsonl", old);
    await write("token-activity.jsonl", [
      { kind: "scan", group: "codex", at: iso(-1), eventCount: 50, firstEventAt: iso(-100 * DAY), lastEventAt: iso(-1) },
      { kind: "activity", group: "codex", slotStart: iso(-1), slotMinutes: 5, events: 1, totalTokens: 10, recordedAt: iso(-1) }
    ]);
    const all = await readQuotaIntegrityInputs({ dataDir: goDir, sinceMs: null });
    assert.equal(all.stats.activityLoadedFromMs, null, "an unbounded read loads everything");
    const history = analyzeQuotaIntegrity({ now, ...all, activityLoadedFromMs: all.stats.activityLoadedFromMs });
    const oldStep = history.steps.find((entry) => entry.deltaPercent === 2);
    assert.deepEqual([oldStep.local.status, oldStep.local.reason], ["not_assessable", "before_local_history"]);
    assert.ok(!history.anomalies.some((entry) => entry.type === "usage_increase_without_local_activity"));
  }

  console.log("Quota integrity data: CRLF/BOM files, torn lines, missing files, baseline carry-in, activity loading and recorder passed.");
} finally {
  await rm(root, { recursive: true, force: true });
}
