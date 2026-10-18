import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const { normalizeSnapshot, historicalSamples, buildHistory, creditChanges, resetCause, snapshotFailureReason, SNAPSHOT_FAILURE_REASONS } = require('../lib/codex-reset-history');
const date = (s) => Date.parse(s);
const snapshot = (at, reset, used, credits = [{ id: 'test-credit', status: 'available', expiresAt: '2026-12-01T00:00:00Z' }], account = 'test-account') => normalizeSnapshot({
  accountId: account, rateLimits: { primary: { usedPercent: used, resetsAt: date(reset) / 1000, windowDurationMins: 10080 } },
  rateLimitResetCredits: { availableCount: credits === null ? 2 : credits.filter(c => c.status === 'available').length, credits }
}, at);
const before = snapshot('2026-09-03T11:59:00Z', '2026-09-08T12:00:00Z', 95);
const after = snapshot('2026-09-03T12:01:00Z', '2026-09-10T12:00:00Z', 1, []);
assert(!JSON.stringify(before).includes('test-account'));
assert(!JSON.stringify(before).includes('test-credit'));
assert.equal(normalizeSnapshot({ rateLimits: {} }), null);
const monthlyLive = normalizeSnapshot({
  accountId: 'test-account',
  rateLimits: { primary: { used_percent: 37, window_minutes: 43200, resets_at: 1794667532 } },
  rateLimitResetCredits: { availableCount: 0, credits: [] }
}, '2026-10-16T03:10:00.000Z');
assert.equal(monthlyLive.window.windowMinutes, 43200, 'non-weekly live quota windows are recorded instead of being mislabeled as collector failures');
assert.equal(monthlyLive.window.usedPercent, 37);
// Real app-server responses can key the non-Spark quota bucket by an opaque provider limit id.
const opaqueBucketResponse = {
  accountId: 'opaque-bucket-account',
  rateLimitsByLimitId: {
    'limit_01': { limitId: 'codex', planType: 'go', primary: { used_percent: 0, window_minutes: 43200, resets_at: 1794893928 } },
    'limit_02': { limitId: 'spark', limitName: 'Codex Spark', primary: { used_percent: 88, window_minutes: 300, resets_at: 1794893928 } }
  },
  rateLimitResetCredits: { availableCount: 0, credits: [] }
};
const opaqueBucketSnapshot = normalizeSnapshot(opaqueBucketResponse, '2026-10-18T06:00:00.000Z');
assert.equal(opaqueBucketSnapshot.window.windowMinutes, 43200, 'uses the non-Spark quota bucket even when its map key is not "codex"');
assert.equal(opaqueBucketSnapshot.window.usedPercent, 0);
assert.equal(snapshotFailureReason(opaqueBucketResponse), 'malformed_response', 'valid opaque-key quota response is not misreported as a collection failure');
assert(!JSON.stringify(opaqueBucketSnapshot).includes('opaque-bucket-account'));
assert(!JSON.stringify(monthlyLive).includes('test-account'), 'account identifiers are hashed before persistence');
assert.equal(before.window.usedPercent, 95);
assert.equal(before.credits.complete, true);
assert.equal(creditChanges(before, after)[0].confidence, 'inferred');
const replaced = snapshot(after.at, after.window.resetsAt, 1, [{ id: 'replacement', status: 'available', expiresAt: '2026-12-01T00:00:00Z' }]);
assert.equal(creditChanges(before, replaced).filter(e => e.type === 'redeemed').length, 1, 'offsetting grant must not hide disappearing credit');
const confirmed = snapshot(after.at, after.window.resetsAt, 1, [{ id: 'test-credit', status: 'redeemed' }]);
assert.equal(creditChanges(before, confirmed)[0].confidence, 'confirmed');
const expiredBefore = snapshot(before.at, before.window.resetsAt, 95, [{ id: 'expired', status: 'available', expiresAt: '2026-09-03T12:00:00Z' }]);
assert.equal(creditChanges(expiredBefore, after)[0].type, 'expired', 'expiry is not a redemption');
const incomplete = snapshot(before.at, before.window.resetsAt, 95, null);
assert.equal(incomplete.credits.complete, false);
assert.equal(creditChanges(incomplete, after)[0].type, 'count_decreased');
assert.equal(creditChanges(before, snapshot(after.at, after.window.resetsAt, 1, [], 'another-account')).length, 0);
const redeeming = snapshot(before.at, before.window.resetsAt, 95, [{id:'test-credit',status:'redeeming',expiresAt:'2026-12-01T00:00:00Z'}]);
assert.equal(creditChanges(redeeming, after)[0].confidence, 'inferred');
const noExpiry = snapshot(before.at, before.window.resetsAt, 95, [{ id: 'test-credit', status: 'available' }]);
assert.equal(creditChanges(noExpiry, after)[0].type, 'missing', 'unknown expiry cannot prove a redemption');
const history = buildHistory([before, after], [], { now: date(after.at) });
assert.equal(history.windows.length, 1);
assert.equal(history.windows[0].resetType, 'early');
assert.equal(history.summary.averageDurationDays, 2);
assert.equal(history.summary.averageMaxUsedPercent, 95);
assert.equal(history.summary.inferredRedemptions, 1);
assert.equal(history.credits.availableCount, 0);
assert.deepEqual(history.windows[0].resetCause, {type:'manual',confidence:'inferred'});
assert.equal(history.summary.manualResets, 1);
const confirmedHistory = buildHistory([before, confirmed], [], {now:date(after.at)});
assert.deepEqual(confirmedHistory.windows[0].resetCause, {type:'manual',confidence:'confirmed'});
const noCreditUsed = snapshot(after.at, after.window.resetsAt, 1);
const providerHistory = buildHistory([before, noCreditUsed], [], {now:date(after.at)});
assert.deepEqual(providerHistory.windows[0].resetCause, {type:'provider_inferred',confidence:'inferred'});
assert.equal(providerHistory.summary.providerResetsInferred, 1);
assert.equal(providerHistory.summary.manualResets, 0);
assert.equal(buildHistory([before, replaced], [], {now:date(after.at)}).summary.manualResets, 1, 'same count with a replacement credit is still manual');
for (const pair of [[incomplete,after],[noExpiry,after],[expiredBefore,after],[redeeming,noCreditUsed],[before,{...noCreditUsed,planType:'different-plan'}]]) {
  assert.equal(resetCause(...pair, 'early').type, 'unknown', 'partial, expired, pending or changed-plan evidence cannot identify a provider reset');
}
assert.equal(resetCause(before,snapshot(after.at, after.window.resetsAt, 1, [], 'different-account'),'early').type,'unknown');
const zeroCreditsBefore = snapshot(before.at,before.window.resetsAt,95,[]);
assert.equal(resetCause(zeroCreditsBefore,after,'early').type,'provider_inferred','complete empty inventories still provide evidence');
const timelyRegularBefore = snapshot('2026-09-08T11:59:00Z',before.window.resetsAt,99);
const timelyRegularAfter = snapshot('2026-09-08T12:01:00Z','2026-09-15T12:00:00Z',1);
assert.equal(buildHistory([timelyRegularBefore,timelyRegularAfter],[],{now:date(timelyRegularAfter.at)}).windows[0].resetCause.type,'scheduled');
const interruptedHistory = buildHistory([before,{kind:'gap',at:'2026-09-03T12:00:00Z'},noCreditUsed],[],{now:date(after.at)});
assert.equal(interruptedHistory.windows[0].resetCause.type,'unknown','an interrupted transition cannot exclude credit use');
const interruptedRedemption = buildHistory([before,{kind:'gap',at:'2026-09-03T12:00:00Z'},after],[],{now:date(after.at)});
assert.deepEqual(interruptedRedemption.windows[0].resetCause,{type:'manual',confidence:'inferred'},'a short failed poll cannot erase before-expiry credit-redemption evidence');
assert.equal(interruptedRedemption.summary.manualResets,1);
assert.equal(interruptedRedemption.summary.recordingGaps,1,'the failed poll remains visible');
assert.equal(resetCause(before,after,'early',true,true).type,'unknown','overlapping windows still block credit attribution');
for (const pair of [[incomplete,after],[noExpiry,after],[expiredBefore,after]]) assert.equal(resetCause(...pair,'early',true).type,'unknown');

const regular = buildHistory([before, snapshot('2026-09-08T12:01:00Z', '2026-09-15T12:00:00Z', 1)], [], { now: date('2026-09-08T12:02:00Z') });
assert.equal(regular.windows[0].resetType, 'regular');
assert.equal(regular.summary.uncertainWindows, 1, 'long observation gap is explicit');
assert.equal(regular.summary.averageDurationDays, null);
assert.equal(regular.windows[0].resetCause.type,'unknown','a scheduled deadline across a long gap does not prove the cause');
const jitter = snapshot('2026-09-03T12:01:00Z', '2026-09-08T12:00:50Z', 96);
assert.equal(buildHistory([before, jitter], [], { now: date(after.at) }).summary.totalWindows, 0);
const rollingZeros = Array.from({length:10}, (_,i) => {
  const at = date('2026-09-01T00:00:00Z') + i * 60000;
  return snapshot(new Date(at).toISOString(), new Date(at + 7 * 86400000).toISOString(), 0);
});
assert.equal(buildHistory(rollingZeros).summary.totalWindows, 0, 'rolling empty deadlines do not create cycles');
const zeroA = snapshot('2026-09-03T12:00:00Z', '2026-09-10T12:00:00Z', 0, []);
const zeroB = snapshot('2026-09-03T12:02:00Z', '2026-09-10T12:00:00Z', 0, []);
assert.equal(buildHistory([before, zeroA, zeroB], [], { now: date(zeroB.at) }).summary.totalWindows, 1);
const stale = snapshot('2026-09-03T13:00:00Z', '2026-09-08T12:00:00Z', 99);
const overlap = buildHistory([before, after, stale], [], { now: date(stale.at) });
assert.equal(overlap.windows[0].overlap, true);
assert.equal(overlap.summary.averageDurationDays, null);
assert.equal(overlap.summary.earlyResets, 0);
assert.equal(overlap.windows[0].resetCause.type,'unknown');
const gaps = buildHistory([before, {kind:'gap',at:'2026-09-03T12:00:00Z'}, {kind:'gap',at:'2026-09-03T12:05:00Z'}], [], { now: date('2026-09-03T12:05:00Z') });
assert.equal(gaps.liveStatus, 'unavailable');
assert.equal(gaps.summary.recordingGaps, 1);
assert.equal(buildHistory([before, after, snapshot(after.at, after.window.resetsAt, 2, [], 'another-account')]).summary.totalWindows, 0, 'live accounts stay separate');
const raw = { timestamp: before.at, rateLimits: { primary: { used_percent:95, window_minutes:10080, resets_at:date(before.window.resetsAt)/1000 } }, transcript:'private', path:'/private/example' };
const imported = historicalSamples([raw, raw]);
assert.equal(imported.length, 1);
assert(!JSON.stringify(imported).includes('private'));
assert.equal(historicalSamples([{...raw, timestamp:'2026-08-01T00:00:00Z'}]).length, 0);
const legacy = buildHistory([], [raw, { ...raw, timestamp:after.at, rateLimits:{primary:{used_percent:1,window_minutes:10080,resets_at:date(after.window.resetsAt)/1000}} }], {now:date(after.at)});
assert.equal(legacy.windows[0].accountScope, 'historical_unscoped');
assert.equal(legacy.windows[0].resetCause.type,'unknown','early historical timing is not an OpenAI reset');
assert.equal(legacy.summary.providerResetsInferred,0);
assert.equal(legacy.summary.unknownResetCauses,1);
// Every language has the same keys and interpolation contract.
const fs = require('node:fs');
const locales = fs.readdirSync(new URL('../public/i18n/', import.meta.url)).filter(n => n.endsWith('.json'));
const en = JSON.parse(await readFile(new URL('../public/i18n/en.json',import.meta.url),'utf8')).codexResets;
for (const name of locales) {
  const translated = JSON.parse(await readFile(new URL('../public/i18n/'+name,import.meta.url),'utf8')).codexResets;
  assert.deepEqual(Object.keys(translated).sort(),Object.keys(en).sort(),name);
  for (const key of Object.keys(en)) assert.deepEqual((translated[key].match(/\{\w+\}/g)||[]).sort(),(en[key].match(/\{\w+\}/g)||[]).sort(),name+':'+key);
}
// Render evidence labels and unavailable values without bootstrap or network calls.
const app = (await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace('\ninit();','\n// bootstrap disabled');
const context = { document:{getElementById:()=>null,querySelector:()=>null,querySelectorAll:()=>[]}, window:{},navigator:{},localStorage:{getItem:()=>null},Intl,Date,console,URLSearchParams,setTimeout,clearTimeout };
const html = vm.runInNewContext(app+`\nstate.translations = ${JSON.stringify({codexResets:en})}; renderCodexResetHistoryContent(${JSON.stringify(history)});`,context);
assert(html.includes('Credit redeemed: inferred'));
assert(html.includes('95 %'));
assert(html.includes('2 days'));
assert(html.includes('Reset cause'));
assert(html.includes('Manual · credit'));
assert(html.includes('Causes: 1 credit · 0 OpenAI (inferred) · 0 scheduled · 0 unknown'));
assert(!html.includes('test-account'));
const unavailableHtml = vm.runInNewContext(app+`\nstate.translations = ${JSON.stringify({codexResets:en})}; renderCodexResetHistoryContent(${JSON.stringify({...history,credits:null})});`,{...context, document:{...context.document}, window:{}});
assert(unavailableHtml.includes('<strong>—</strong>'));
// Re-open the ledger in a fresh process and verify the authenticated HTTP route.
const { mkdtemp, rm, stat } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { execFileSync } = await import('node:child_process');
const dir = await mkdtemp(join(tmpdir(), 'codex-reset-history-'));
const serverPath = require.resolve('../server.js');
const environment = {...process.env, LLM_USAGE_DATA_DIR:dir, CODEX_LIVE_RATE_LIMITS:'false', DASHBOARD_PASSWORD:'', OIDC_ISSUER_URL:''};
try {
  execFileSync(process.execPath, ['-e', `
    const { _test } = require(${JSON.stringify(serverPath)});
    (async () => {
      await _test.recordCodexResetSnapshot(${JSON.stringify(before)});
      await _test.recordCodexResetSnapshot(${JSON.stringify(after)});
      await _test.saveCodexHistoricalSamples(${JSON.stringify([raw])});
    })().catch(e => {console.error(e);process.exitCode=1});
  `], {env:environment});
  execFileSync(process.execPath, ['-e', `
    const assert=require('node:assert/strict');
    const {app}=require(${JSON.stringify(serverPath)});
    const server=app.listen(0,'127.0.0.1',async()=>{
      try {
        const r=await fetch('http://127.0.0.1:'+server.address().port+'/api/codex-reset-history?limit=10');
        assert.equal(r.status,200); const h=await r.json();
        assert.equal(h.summary.inferredRedemptions,1); assert.equal(h.windows.length,1);
        assert.equal(h.credits.availableCount,0);
        assert.equal(h.windows[0].resetCause.type,'manual');
        assert.equal(h.summary.manualResets,1);
      } catch(e) {console.error(e);process.exitCode=1} finally {server.close()}
    });
  `], {env:environment});
  if (process.platform !== 'win32') assert.equal((await stat(join(dir,'codex-reset-snapshots.jsonl'))).mode & 0o777,0o600);
} finally {await rm(dir,{recursive:true,force:true})}

// ---------------------------------------------------------------- window choice, strict inputs, failure reasons, recording status
{
  const RESET = 1794667532;
  const at = '2026-10-16T03:10:00.000Z';
  const win = (minutes, used, key = 'snake') => key === 'snake'
    ? { used_percent: used, window_minutes: minutes, resets_at: RESET } : { usedPercent: used, windowDurationMins: minutes, resetsAt: RESET };
  const response = (primary, secondary, extra = {}) => ({ accountId: 'raw-id-never-stored', rateLimits: { planType: 'go', primary, secondary }, ...extra });
  // The observed Go-plan response, in both field spellings.
  for (const key of ['snake', 'camel']) {
    const one = normalizeSnapshot(response(win(43200, 37, key), null), at);
    assert.deepEqual([one.window.usedPercent, one.window.windowMinutes, one.window.resetsAt, one.planType, one.source, one.kind], [37, 43200, new Date(RESET * 1000).toISOString(), 'go', 'live', 'sample'], key);
    assert.match(one.accountKey, /^[0-9a-f]{24}$/);
    assert.ok(!JSON.stringify(one).includes('raw-id-never-stored'), 'the raw account id is never kept');
  }
  // Which window is recorded does not depend on the order the response lists them in, or on whether a short one is present.
  const chosen = (primary, secondary) => normalizeSnapshot(response(primary, secondary), at)?.window.windowMinutes;
  assert.equal(chosen(win(43200, 1), win(10080, 2)), 10080, 'weekly beats monthly');
  assert.equal(chosen(win(10080, 2), win(43200, 1)), 10080);
  assert.equal(chosen(win(300, 1), win(10080, 2)), 10080);
  assert.equal(chosen(win(300, 1), win(43200, 2)), 43200, 'otherwise the longest window');
  assert.equal(chosen(win(43200, 2), win(300, 1)), 43200);
  assert.equal(chosen(win(43200, 2), null), 43200, 'the same window is chosen when the short one is absent');
  assert.equal(chosen(null, win(43200, 2)), 43200, 'a window in the secondary slot alone is recorded');
  assert.equal(chosen(win(300, 1), null), 300);
  // A window that is not a complete, bounded, numeric window is not recorded; another valid one still is.
  for (const bad of [{ ...win(43200, 37), window_minutes: true }, { ...win(43200, 37), window_minutes: [43200] }, { ...win(43200, 37), window_minutes: '' }, win(0, 37), win(-5, 37), win(525601, 37), { ...win(43200, 37), used_percent: true }, { ...win(43200, 37), used_percent: [5] }, { ...win(43200, 37), used_percent: null }, { ...win(43200, 37), resets_at: null }, { ...win(43200, 37), resets_at: 'soon' }, 'primary', [win(43200, 37)]]) {
    assert.equal(normalizeSnapshot(response(bad, null), at), null, JSON.stringify(bad));
    assert.equal(chosen(bad, win(43200, 5)), 43200, 'a valid second window is not lost to an invalid first one');
  }
  assert.equal(normalizeSnapshot(response({ ...win(43200, 37), window_minutes: '43200' }, null), at)?.window.windowMinutes, 43200, 'numeric strings are accepted');
  assert.equal(normalizeSnapshot({ rateLimits: { primary: win(43200, 37) } }, at), null, 'a snapshot is only recorded when it can be tied to an account');

  // Failure reasons: fixed vocabulary, no content.
  assert.deepEqual([...SNAPSHOT_FAILURE_REASONS].sort(), ['malformed_response', 'no_account_id', 'no_quota_window', 'request_failed']);
  assert.equal(snapshotFailureReason(null), 'malformed_response');
  assert.equal(snapshotFailureReason('text'), 'malformed_response');
  assert.equal(snapshotFailureReason({ accountId: 'x' }), 'no_quota_window');
  assert.equal(snapshotFailureReason({ accountId: 'x', rateLimits: { primary: null, secondary: null } }), 'no_quota_window');
  assert.equal(snapshotFailureReason({ accountId: 'x', rateLimits: { primary: { ...win(43200, 1), window_minutes: true } } }), 'no_quota_window');
  assert.equal(snapshotFailureReason({ rateLimits: { primary: win(43200, 37) } }), 'no_account_id', 'a usable window but no account id');
  assert.equal(snapshotFailureReason({ rateLimitsByLimitId: { codex: { primary: win(43200, 37) } } }), 'no_account_id');
  assert.equal(snapshotFailureReason(response(win(43200, 37), null)), 'malformed_response', 'a response that WOULD record is not described as a failure');

  // Recording status and the weekly-only history. A Go collector that works is "live" with an empty weekly history.
  const now = Date.parse('2026-10-16T03:20:00.000Z');
  const go = (minute, used = 37) => normalizeSnapshot(response(win(43200, used), null), new Date(now - minute * 60000).toISOString());
  const goRecords = [go(30), go(20), go(10), go(1)];
  const live = buildHistory(goRecords, [], { now });
  assert.deepEqual([live.liveStatus, live.lastLiveAt, live.current, live.windows.length, live.summary.totalWindows], ['live', go(1).at, null, 0, 0]);
  assert.equal(live.recordingStartedAt, go(30).at);
  assert.equal(live.summary.expectedDurationDays, 7, 'the history is still the weekly one');
  assert.equal(buildHistory([go(30), go(20)], [], { now }).liveStatus, 'stale', 'old monthly samples are stale like weekly ones');
  assert.equal(buildHistory([...goRecords, { kind: 'gap', at: new Date(now - 30000).toISOString(), status: 'unavailable', reason: 'no_quota_window' }], [], { now }).liveStatus, 'unavailable', 'a failure after the last sample');
  assert.equal(buildHistory([], [], { now }).liveStatus, 'unavailable');
  // Monthly samples change nothing about the weekly windows of an account that also reports a weekly window.
  const weeklyRecords = [snapshot('2026-09-03T11:59:00Z', '2026-09-08T12:00:00Z', 95), snapshot('2026-09-03T12:01:00Z', '2026-09-10T12:00:00Z', 1)];
  const weeklyOnly = buildHistory(weeklyRecords, [], { now: date('2026-09-03T12:06:00Z') });
  const withMonthly = buildHistory([...weeklyRecords, normalizeSnapshot(response(win(43200, 37), null), '2026-09-03T12:05:00Z')].map((row) => (row.window.windowMinutes === 43200 ? { ...row, accountKey: weeklyRecords[0].accountKey } : row)), [], { now: date('2026-09-03T12:06:00Z') });
  assert.deepEqual(withMonthly.windows, weeklyOnly.windows, 'the weekly history is unchanged by the other window type');
  assert.equal(withMonthly.liveStatus, 'live');
}

console.log('Codex reset history: evidence, privacy, gaps, accounts, rolling deadlines, locales and rendering passed.');
