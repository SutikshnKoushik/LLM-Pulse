import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const serverPath = require.resolve("../server.js");
const dataDir = await mkdtemp(path.join(tmpdir(), "quota-integrity-api-"));
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const minute = 60_000;
const reset = iso(now + 5 * 24 * 60 * minute);
const events = [
  { type: "quota_window", provider: "codex", windowKey: "weekly", capturedAt: iso(now - 120_000), usedPercent: 42, remainingPercent: 58, resetsAt: reset },
  { type: "quota_window", provider: "codex", windowKey: "weekly", capturedAt: iso(now - 60_000), usedPercent: 36, remainingPercent: 64, resetsAt: reset, prompt: "must not appear in report", accessToken: "must-not-leak" }
];
// A day of one-minute snapshots at 95%, then a 2 point step observed 40 minutes ago with no recorded local activity.
const snapshots = [];
for (let m = 1500; m >= 1; m--) snapshots.push({ kind: "sample", source: "live", at: iso(now - m * minute), accountKey: "one-way-hash", planType: "plus", window: { usedPercent: m > 40 ? 95 : 97, resetsAt: reset, windowMinutes: 10080 } });
const activity = [
  { kind: "activity", group: "codex", slotStart: iso(Math.floor((now - 3000 * minute) / (5 * minute)) * 5 * minute), slotMinutes: 5, events: 2, totalTokens: 5000, recordedAt: iso(now - minute) },
  { kind: "scan", group: "codex", at: iso(now - minute), eventCount: 2, firstEventAt: iso(now - 3000 * minute), lastEventAt: iso(now - 3000 * minute), secretPath: "C:\\Users\\private\\.codex" }
];
const lines = (rows) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";

async function run(password) {
  const code = `
    const assert = require('node:assert/strict');
    const { app } = require(${JSON.stringify(serverPath)});
    const server = app.listen(0, '127.0.0.1', async () => {
      try {
        const base = 'http://127.0.0.1:' + server.address().port;
        const response = await fetch(base + '/api/quota-integrity?sinceHours=168');
        if (${JSON.stringify(Boolean(password))}) {
          assert.equal(response.status, 401, 'the route is behind the dashboard authentication');
          assert.equal((await response.json()).error, 'auth_required');
          return;
        }
        assert.equal(response.status, 200);
        const report = await response.json();
        assert.equal(report.schemaVersion, 2);
        assert.ok(report.anomalies.some((entry) => entry.type === 'usage_rolled_back'));
        assert.equal(report.coverage.validQuotaEvents, 2);
        const finding = report.anomalies.find((entry) => entry.type === 'usage_increase_without_local_activity');
        assert.ok(finding, 'the 95% -> 97% step with working local logs and no activity is reported');
        assert.equal(finding.deltaPercent, 2);
        assert.ok(Array.isArray(finding.hypotheses) && finding.hypotheses.length >= 3);
        assert.ok(report.history.codexWeekly.points.length >= 2);
        assert.equal(report.freshness.codex.status, 'live');
        assert.ok(report.coverage.tokenActivity.slotRecords >= 1);
        const body = JSON.stringify(report);
        for (const secret of ['must-not-leak', 'must not appear in report', 'one-way-hash', 'secretPath', 'private']) assert.ok(!body.includes(secret), 'leaked ' + secret);
        const narrow = await (await fetch(base + '/api/quota-integrity?sinceHours=0.5')).json();
        assert.equal(narrow.range.since !== null, true);
        const bogus = await fetch(base + '/api/quota-integrity?sinceHours=abc');
        assert.equal(bogus.status, 200, 'an invalid range falls back to the default instead of failing');
      } catch (error) {
        console.error(error);
        process.exitCode = 1;
      } finally {
        server.close();
      }
    });
  `;
  execFileSync(process.execPath, ["-e", code], {
    encoding: "utf8",
    env: { ...process.env, LLM_USAGE_DATA_DIR: dataDir, CODEX_LIVE_RATE_LIMITS: "false", DASHBOARD_PASSWORD: password, OIDC_ISSUER_URL: "" }
  });
}

// ---------------------------------------------------------------- a Go plan: one 30-day window, no weekly window at all
const goDir = await mkdtemp(path.join(tmpdir(), "quota-integrity-api-go-"));
const goReset = iso(now + 12 * 24 * 60 * minute);
const goSnapshots = [];
for (let m = 1500; m >= 1; m--) goSnapshots.push({ kind: "sample", source: "live", at: iso(now - m * minute), accountKey: "go-one-way-hash", planType: "go", window: { usedPercent: m > 40 ? 37 : 39, resetsAt: goReset, windowMinutes: 43200 } });
const goGaps = [90, 85, 80].map((m) => ({ kind: "gap", at: iso(now - (1500 + m) * minute), status: "unavailable", reason: "no_quota_window" }));
const goActivity = [
  { kind: "activity", group: "codex", slotStart: iso(Math.floor((now - 10 * 24 * 60 * minute) / (5 * minute)) * 5 * minute), slotMinutes: 5, events: 3, totalTokens: 9000, recordedAt: iso(now - minute) },
  { kind: "scan", group: "codex", at: iso(now - minute), eventCount: 3, firstEventAt: iso(now - 25 * 24 * 60 * minute), lastEventAt: iso(now - 10 * 24 * 60 * minute) }
];

async function runGo() {
  const code = `
    const assert = require('node:assert/strict');
    const { app } = require(${JSON.stringify(serverPath)});
    const server = app.listen(0, '127.0.0.1', async () => {
      try {
        const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/quota-integrity?sinceHours=168');
        assert.equal(response.status, 200);
        const report = await response.json();
        assert.equal(report.coverage.codexLiveSamples, 1500, 'every monthly snapshot is counted');
        assert.equal(report.coverage.codexWeeklySamples, 0, 'none of them is weekly');
        assert.deepEqual(report.coverage.codexWindowTypes, ['window_43200m']);
        assert.equal(report.freshness.codex.status, 'live');
        assert.equal(report.history.codexWeekly.points.length, 0, 'the weekly chart data stays empty');
        const row = report.history.windows.find((entry) => entry.windowKey === 'window_43200m');
        assert.deepEqual([row.windowLabel, row.lastUsedPercent, row.source], ['30d', 39, 'codex_snapshot']);
        assert.ok(!report.history.windows.some((entry) => entry.windowKey === 'weekly'));
        // The 2-point rise is compared with local activity inside the 30-day window (found 10 days back, beyond the old 8-day look-back), so no warning.
        const step = report.steps.find((entry) => entry.deltaPercent === 2);
        assert.equal(step.windowKey, 'window_43200m');
        assert.equal(step.local.status, 'activity_present');
        assert.ok(!report.anomalies.some((entry) => entry.type === 'usage_increase_without_local_activity'));
        assert.ok(!report.anomalies.some((entry) => entry.type === 'no_live_codex_samples'));
        const body = JSON.stringify(report);
        for (const secret of ['go-one-way-hash', 'rateLimits', 'used_percent']) assert.ok(!body.includes(secret), 'leaked ' + secret);
      } catch (error) { console.error(error); process.exitCode = 1; } finally { server.close(); }
    });
  `;
  execFileSync(process.execPath, ["-e", code], { encoding: "utf8", env: { ...process.env, LLM_USAGE_DATA_DIR: goDir, CODEX_LIVE_RATE_LIMITS: "false", DASHBOARD_PASSWORD: "", OIDC_ISSUER_URL: "" } });
}

try {
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, "quota-events.jsonl"), lines(events));
  await writeFile(path.join(dataDir, "codex-reset-snapshots.jsonl"), lines(snapshots));
  await writeFile(path.join(dataDir, "token-activity.jsonl"), lines(activity));
  await run("");
  await run("a-test-password");
  await writeFile(path.join(goDir, "codex-reset-snapshots.jsonl"), [...goGaps, ...goSnapshots].map((row) => JSON.stringify(row)).join("\n") + "\n");
  await writeFile(path.join(goDir, "token-activity.jsonl"), goActivity.map((row) => JSON.stringify(row)).join("\n") + "\n");
  await runGo();
  console.log("Quota integrity API: authentication, schema, activity correlation, a 30-day-window (Go) account, range handling and metadata privacy passed.");
} finally {
  await rm(goDir, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
}
