import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const serverPath = require.resolve("../server.js");
const dataDir = await mkdtemp(path.join(tmpdir(), "codex-go-collector-"));

// Runs the REAL collection decision (collectCodexResetSnapshotOnce) against a fake app-server client.
const code = `
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');
  const { _test } = require(${JSON.stringify(serverPath)});
  const file = path.join(process.env.LLM_USAGE_DATA_DIR, 'codex-reset-snapshots.jsonl');
  const rows = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse) : []);
  const run = (response) => _test.collectCodexResetSnapshotOnce(async () => ({ request: async (method) => { assert.equal(method, 'account/rateLimits/read'); if (response instanceof Error) throw response; return response; } }));
  const RAW_ID = 'raw-account-id-must-never-be-stored';
  const RESET = 1794667532; // seconds
  (async () => {
    // 1. The response observed on a Go plan with Codex CLI 0.162.1: one 30-day primary window, no secondary.
    const go = { accountId: RAW_ID, rateLimits: { limitId: 'codex', planType: 'go', primary: { used_percent: 37, window_minutes: 43200, resets_at: RESET }, secondary: null } };
    assert.equal(await run(go), 'recorded', 'a valid monthly response is a success');
    let all = rows();
    assert.equal(all.length, 1);
    assert.equal(all[0].kind, 'sample', 'a live sample is recorded');
    assert.equal(all.filter((row) => row.kind === 'gap').length, 0, 'no failure record for a valid non-weekly window');
    assert.deepEqual([all[0].window.usedPercent, all[0].window.windowMinutes, all[0].window.resetsAt], [37, 43200, new Date(RESET * 1000).toISOString()]);
    assert.equal(all[0].source, 'live');
    assert.equal(all[0].planType, 'go');

    // 2. Same data in the camelCase app-server shape.
    const camel = { accountId: RAW_ID, rateLimits: { planType: 'go', primary: { usedPercent: 38, windowDurationMins: 43200, resetsAt: RESET }, secondary: null } };
    assert.equal(await run(camel), 'recorded');
    assert.equal(rows().at(-1).window.windowMinutes, 43200);
    assert.equal(rows().at(-1).window.usedPercent, 38);

    // 3. An account that reports both a weekly and a monthly window: the weekly one is recorded, whatever the order.
    const both = (primary, secondary) => ({ accountId: RAW_ID, rateLimits: { planType: 'pro', primary, secondary } });
    const weekly = { used_percent: 61, window_minutes: 10080, resets_at: RESET }, monthly = { used_percent: 12, window_minutes: 43200, resets_at: RESET + 86400 };
    assert.equal(await run(both(monthly, weekly)), 'recorded');
    assert.deepEqual([rows().at(-1).window.windowMinutes, rows().at(-1).window.usedPercent], [10080, 61]);
    assert.equal(await run(both(weekly, monthly)), 'recorded');
    assert.equal(rows().at(-1).window.windowMinutes, 10080);

    // 4. A five-hour and a monthly window only: the longer one, independent of order.
    const five = { used_percent: 9, window_minutes: 300, resets_at: RESET };
    await run(both(five, { ...monthly, used_percent: 13 })); assert.equal(rows().at(-1).window.windowMinutes, 43200);
    await run(both({ ...monthly, used_percent: 14 }, five)); assert.equal(rows().at(-1).window.windowMinutes, 43200);

    // 5. Failures are recorded with a fixed reason and never with response content.
    const before = rows().length;
    assert.equal(await run({ accountId: RAW_ID, rateLimits: { primary: null, secondary: null } }), 'no_quota_window');
    assert.equal(await run({ rateLimits: { planType: 'go', primary: { used_percent: 40, window_minutes: 43200, resets_at: RESET } } }), 'no_account_id');
    assert.equal(await run(new Error('socket closed C:\\\\Users\\\\someone secret-token')), 'request_failed');
    assert.equal(await run(null), 'malformed_response');
    assert.equal(await run({ accountId: RAW_ID, rateLimits: { primary: { used_percent: 40, window_minutes: true, resets_at: RESET } } }), 'no_quota_window', 'a boolean duration is not a window');
    const gaps = rows().slice(before);
    assert.deepEqual(gaps.map((row) => [row.kind, row.status, row.reason]), [
      ['gap', 'unavailable', 'no_quota_window'], ['gap', 'unavailable', 'no_account_id'], ['gap', 'unavailable', 'request_failed'],
      ['gap', 'unavailable', 'malformed_response'], ['gap', 'unavailable', 'no_quota_window']
    ]);

    // 6. Privacy: the file holds no raw account id, no raw response, no error text, no path.
    const text = fs.readFileSync(file, 'utf8');
    for (const secret of [RAW_ID, 'rateLimits', 'limitId', 'secret-token', 'someone', 'used_percent', 'window_minutes']) assert.ok(!text.includes(secret), 'leaked ' + secret);
    for (const row of rows().filter((entry) => entry.kind === 'sample')) assert.match(row.accountKey, /^[0-9a-f]{24}$/, 'account is only a one-way key');
    console.log('collector ok');
  })().catch((error) => { console.error(error); process.exitCode = 1; });
`;

try {
  const output = execFileSync(process.execPath, ["-e", code], {
    encoding: "utf8",
    env: { ...process.env, LLM_USAGE_DATA_DIR: dataDir, CODEX_LIVE_RATE_LIMITS: "false", DASHBOARD_PASSWORD: "", OIDC_ISSUER_URL: "" }
  });
  assert.match(output, /collector ok/);
  console.log("Codex Go plan collector: monthly response recorded without a gap, weekly preferred, deterministic window choice, failure reasons and privacy passed.");
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
