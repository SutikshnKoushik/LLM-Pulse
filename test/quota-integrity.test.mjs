import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { analyzeQuotaIntegrity } = require("../lib/quota-integrity.js");
const { foldActivityRecords } = require("../lib/token-activity.js");

const now = Date.parse("2026-10-14T10:00:00.000Z");
const at = (minutes) => new Date(now + minutes * 60_000).toISOString();
const reset = at(7 * 24 * 60);
const event = (minutes, usedPercent, resetsAt = reset, extra = {}) => ({
  type: "quota_window", provider: "codex", windowKey: "weekly", label: "Weekly",
  capturedAt: at(minutes), usedPercent, remainingPercent: 100 - usedPercent, resetsAt,
  ...extra
});
const snapshot = (minutes, usedPercent, resetsAt = reset, accountKey = "hashed-account-a") => ({
  kind: "sample", source: "live", at: at(minutes), accountKey, planType: "plus",
  window: { usedPercent, resetsAt, windowMinutes: 10080 }
});

{
  const report = analyzeQuotaIntegrity({
    now,
    quotaEvents: [event(-20, 10), event(-10, 15), event(0, 18)],
    codexSnapshots: [snapshot(-2, 17), snapshot(-1, 18)]
  });
  assert.equal(report.summary.total, 0, "normal increasing usage is not an anomaly");
  assert.equal(report.summary.status, "no_anomaly_detected");
}

{
  const report = analyzeQuotaIntegrity({ now, quotaEvents: [event(-2, 42), event(-1, 36)] });
  const rollback = report.anomalies.find((entry) => entry.type === "usage_rolled_back");
  assert.ok(rollback, "a meaningful same-window usage rollback is detected");
  assert.equal(rollback.deltaPercent, -6);
  assert.match(rollback.explanation, /does not by itself prove a service bug/);
}

{
  const earlierDeadline = at(12 * 60);
  const report = analyzeQuotaIntegrity({ now, quotaEvents: [event(-20, 60), event(-10, 62, earlierDeadline)] });
  assert.ok(report.anomalies.some((entry) => entry.type === "reset_deadline_changed_early"));
}

{
  const regularReset = at(-30);
  const nextDeadline = at(7 * 24 * 60 - 30);
  const report = analyzeQuotaIntegrity({ now, quotaEvents: [event(-20, 91, regularReset), event(-10, 2, nextDeadline)] });
  assert.ok(!report.anomalies.some((entry) => entry.type === "reset_deadline_changed_early"), "a reset after the old deadline is not considered early");
}

{
  const report = analyzeQuotaIntegrity({
    now,
    codexSnapshots: [snapshot(-3, 80, reset, "hashed-account-a"), snapshot(-2, 5, at(7 * 24 * 60), "hashed-account-b")]
  });
  assert.ok(!report.anomalies.some((entry) => entry.type === "usage_rolled_back"), "snapshots from different accounts are not compared");
}

{
  const report = analyzeQuotaIntegrity({ now, codexSnapshots: [
    { kind: "gap", at: at(-15), status: "unavailable" },
    { kind: "gap", at: at(-10), status: "unavailable" },
    snapshot(-2, 20)
  ] });
  const gap = report.anomalies.find((entry) => entry.type === "collector_gap");
  assert.ok(gap, "consecutive collector failures are grouped into an incident");
  assert.equal(gap.recoveredAt, at(-2));
}

{
  const report = analyzeQuotaIntegrity({ now, codexSnapshots: [snapshot(-20, 10)] });
  assert.ok(report.anomalies.some((entry) => entry.type === "stale_codex_snapshot"));
}

{
  const report = analyzeQuotaIntegrity({ now, quotaEvents: [
    event(-1, 40, reset, { accountId: "private-account-id", accessToken: "secret", prompt: "private prompt" }),
    { type: "quota_status", provider: "codex", windowKey: "sync_status", status: "live" },
    { type: "quota_window", provider: "codex", windowKey: "weekly", capturedAt: "not-a-date", usedPercent: 120 }
  ], codexSnapshots: [snapshot(0, 40)] });
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes("private-account-id"));
  assert.ok(!serialized.includes("secret"));
  assert.ok(!serialized.includes("private prompt"));
  assert.equal(report.coverage.ignoredQuotaEvents, 1);
}

{
  const monthlyReset = at(30 * 24 * 60);
  const monthly = (minutes, usedPercent) => ({
    kind: "sample", source: "live", at: at(minutes), accountKey: "hashed-monthly-account", planType: "go",
    window: { usedPercent, resetsAt: monthlyReset, windowMinutes: 43200 }
  });
  const report = analyzeQuotaIntegrity({ now, codexSnapshots: [monthly(-2, 42), monthly(-1, 35)] });
  const rollback = report.anomalies.find((entry) => entry.type === "usage_rolled_back");
  assert.ok(rollback, "monthly Go-plan quota windows are analyzed rather than discarded as non-weekly");
  assert.equal(rollback.windowKey, "window_43200m", "same key as the quota ledger uses for this window");
  assert.equal(report.coverage.codexLiveSamples, 2);
  assert.deepEqual(report.coverage.codexWindowTypes, ["window_43200m"]);
  assert.equal(report.coverage.codexWeeklySamples, 0, "a monthly-only account has no weekly snapshots");
}

console.log("Quota integrity: rollback, reset shifts, account separation, collector gaps, staleness, and privacy passed.");
// ---------------------------------------------------------------- v2: gaps, rolling deadlines, credits, accounts
const types = (report) => report.anomalies.map((entry) => entry.type);
const creditSnapshot = (minutes, usedPercent, resetsAt, items, accountKey = "hashed-account-a") => ({
  ...snapshot(minutes, usedPercent, resetsAt, accountKey),
  credits: { availableCount: items.filter((c) => c.status === "available").length, complete: true, items }
});

{
  // One long outage is one incident even though the recorder repeats a failure row every ~5 minutes.
  const gaps = [-60, -54.9, -49.8, -44.7, -39.6, -34.5, -29.4].map((m) => ({ kind: "gap", at: at(m), status: "unavailable" }));
  const report = analyzeQuotaIntegrity({ now, codexSnapshots: [snapshot(-70, 10), ...gaps, snapshot(-1, 10)] });
  const incidents = report.anomalies.filter((entry) => entry.type === "collector_gap");
  assert.equal(incidents.length, 1, "repeated failure rows form one incident");
  assert.equal(incidents[0].durationMinutes, 69, "duration runs from the last good sample to recovery");
  assert.equal(incidents[0].failureRecords, 7);
  assert.equal(report.gaps.length, 1);
}

{
  // A single failed poll that recovers within a minute is not an incident.
  const report = analyzeQuotaIntegrity({ now, codexSnapshots: [snapshot(-4, 10), { kind: "gap", at: at(-3), status: "unavailable" }, snapshot(-2, 10), snapshot(-1, 10)] });
  assert.ok(!types(report).includes("collector_gap"));
}

{
  // Dashboard closed / machine asleep: no failure rows at all, but the cadence stops.
  const report = analyzeQuotaIntegrity({ now, codexSnapshots: [snapshot(-600, 10), snapshot(-1, 12)] });
  const silent = report.anomalies.find((entry) => entry.type === "observation_gap");
  assert.ok(silent, "a long interval with no observations is reported");
  assert.equal(silent.severity, "info");
  assert.equal(silent.durationMinutes, 599);
  assert.ok(!types(report).includes("collector_gap"));
  assert.equal(report.gaps[0].kind, "no_observations");
}

{
  // An outage that is still ongoing is flagged as such and the collector reads as unavailable.
  const report = analyzeQuotaIntegrity({ now, codexSnapshots: [snapshot(-30, 10), { kind: "gap", at: at(-20), status: "unavailable" }, { kind: "gap", at: at(-14.9), status: "unavailable" }] });
  const incident = report.anomalies.find((entry) => entry.type === "collector_gap");
  assert.equal(incident.ongoing, true);
  assert.equal(incident.recoveredAt, null);
  assert.equal(report.freshness.codex.status, "unavailable");
}

{
  // An unused window reports a rolling "now + 7 days" deadline; that is not an early reset.
  const rolling = (minutes) => event(minutes, 0, at(minutes + 7 * 24 * 60));
  const report = analyzeQuotaIntegrity({ now, quotaEvents: [rolling(-30), rolling(-1)] });
  assert.ok(!types(report).includes("reset_deadline_changed_early"));
  // The first use anchors the deadline: moving from the rolling value is also expected.
  const anchored = analyzeQuotaIntegrity({ now, quotaEvents: [rolling(-300), event(-1, 3, at(-250 + 7 * 24 * 60))] });
  assert.ok(!types(anchored).includes("reset_deadline_changed_early"));
}

{
  // A confirmed credit redemption explains the early reset instead of leaving an unexplained warning.
  const early = at(2 * 24 * 60);
  const report = analyzeQuotaIntegrity({ now, codexSnapshots: [
    creditSnapshot(-3, 95, early, [{ key: "k1", status: "available", expiresAt: at(30 * 24 * 60) }]),
    creditSnapshot(-2, 1, reset, [{ key: "k1", status: "redeemed" }])
  ] });
  const entry = report.anomalies.find((item) => item.type === "reset_deadline_changed_early");
  assert.ok(entry);
  assert.equal(entry.severity, "info");
  assert.deepEqual(entry.explainedBy, { code: "reset_credit_redeemed", confidence: "confirmed" });
  assert.equal(entry.resetCause.type, "manual");
  assert.equal(report.summary.status, "no_anomaly_detected");
  assert.ok(!JSON.stringify(report).includes("k1"), "opaque credit keys are never emitted");
}

{
  // A credit that disappeared without any redemption evidence stays a warning, labelled as provider-inferred.
  const early = at(2 * 24 * 60);
  const report = analyzeQuotaIntegrity({ now, codexSnapshots: [creditSnapshot(-3, 95, early, []), creditSnapshot(-2, 1, reset, [])] });
  const entry = report.anomalies.find((item) => item.type === "reset_deadline_changed_early");
  assert.equal(entry.severity, "warning");
  assert.equal(entry.explainedBy, undefined);
  assert.equal(entry.resetCause.type, "provider_inferred");
}

{
  // Account change between snapshots: reported once as information, never compared across accounts.
  const report = analyzeQuotaIntegrity({ now, codexSnapshots: [snapshot(-4, 90, reset, "hashed-account-a"), snapshot(-3, 5, at(3 * 24 * 60), "hashed-account-b"), snapshot(-2, 6, at(3 * 24 * 60), "hashed-account-b")] });
  assert.equal(report.anomalies.filter((entry) => entry.type === "account_changed").length, 1);
  assert.equal(report.coverage.codexAccountChanges, 1);
  assert.ok(!types(report).includes("usage_rolled_back"));
  assert.ok(!JSON.stringify(report).includes("hashed-account"));
}

{
  // A ledger rollback that straddles an account switch is flagged as possibly explained, not as a bare warning.
  const report = analyzeQuotaIntegrity({
    now,
    quotaEvents: [event(-40, 80), event(-1, 20)],
    codexSnapshots: [snapshot(-30, 80, reset, "hashed-account-a"), snapshot(-20, 20, reset, "hashed-account-b")]
  });
  const entry = report.anomalies.find((item) => item.type === "usage_rolled_back");
  assert.deepEqual(entry.explainedBy, { code: "account_changed", confidence: "possible" });
  assert.equal(entry.severity, "info");
}

{
  // Normal weekly rollover after the old deadline is never an anomaly and shows up as a rollover in the history.
  const old = at(-30);
  const report = analyzeQuotaIntegrity({ now, codexSnapshots: [snapshot(-45, 97, old), snapshot(-20, 1, at(7 * 24 * 60 - 20))] });
  assert.ok(!types(report).includes("reset_deadline_changed_early"));
  assert.ok(!types(report).includes("usage_rolled_back"));
  assert.ok(report.history.codexWeekly.points.some((point) => point.change === "rollover"));
}

{
  // Duplicates, time zones and epoch seconds are normalized: the same instant never looks like a change.
  const seconds = Math.floor(Date.parse(at(-1)) / 1000);
  const report = analyzeQuotaIntegrity({ now, quotaEvents: [
    event(-2, 40), event(-2, 40), // exact duplicate
    { ...event(-1, 40), capturedAt: seconds, resetsAt: new Date(Date.parse(reset)).toISOString().replace("Z", "+00:00") },
    { ...event(0, 41), capturedAt: new Date(now).toISOString().replace("Z", "+00:00") }
  ] });
  assert.deepEqual(types(report), ["no_live_codex_samples"], "no change findings; only the informational missing-snapshot note");
  assert.equal(report.coverage.validQuotaEvents, 3, "the exact duplicate row is counted once");
  const offset = analyzeQuotaIntegrity({ now, quotaEvents: [
    { ...event(0, 50), capturedAt: "2026-10-14T15:30:00+05:30", resetsAt: reset },
    { ...event(0, 44), capturedAt: "2026-10-14T10:01:00Z", resetsAt: reset }
  ] });
  assert.ok(types(offset).includes("usage_rolled_back"), "10:00Z written as 15:30+05:30 sorts before 10:01Z");
}

{
  // Malformed and missing fields never throw and are only counted.
  const report = analyzeQuotaIntegrity({ now, quotaEvents: [
    null, 7, "text", {}, { type: "quota_window" },
    { type: "quota_window", provider: "codex", windowKey: "weekly", capturedAt: at(-1), usedPercent: true },
    { type: "quota_window", provider: "codex", windowKey: "weekly", capturedAt: at(-1), usedPercent: [5] },
    { type: "quota_window", provider: "codex", windowKey: "weekly", capturedAt: at(-1), usedPercent: -1 },
    { type: "quota_window", provider: "bad provider!", windowKey: "weekly", capturedAt: at(-1), usedPercent: "12" }
  ], codexSnapshots: [null, {}, { kind: "sample" }, { kind: "sample", source: "live", at: at(-1), window: { usedPercent: 5 } }] });
  assert.equal(report.coverage.ignoredQuotaEvents, 4, "missing provider, boolean, array and negative percentages are ignored; non-window rows are not counted");
  assert.equal(report.coverage.codexWeeklySamples, 0);
  assert.equal(report.coverage.validQuotaEvents, 1, "a numeric-string percentage is accepted");
}

{
  // Result is bounded and says so.
  const quotaEvents = [];
  for (let i = 0; i < 40; i++) quotaEvents.push(event(-100 + i * 2, 80), event(-99 + i * 2, 70));
  const report = analyzeQuotaIntegrity({ now, quotaEvents }, { maxAnomalies: 10 });
  assert.equal(report.summary.truncated, true);
  assert.equal(report.anomalies.length, 10);
  assert.ok(report.summary.totalBeforeLimit > 10);
}

{
  // Events before sinceMs are only comparison baselines: a rollback inside the range is found, one before is not reported.
  const since = now - 30 * 60_000;
  const report = analyzeQuotaIntegrity({ now, sinceMs: since, quotaEvents: [event(-200, 50), event(-100, 40), event(-10, 31)] });
  assert.equal(report.anomalies.filter((entry) => entry.type === "usage_rolled_back").length, 1);
  assert.equal(report.anomalies.find((entry) => entry.type === "usage_rolled_back").observedAt, at(-10));
}

// ---------------------------------------------------------------- v2: correlation with local token activity
const slot = (minutes, group = "codex", extra = {}) => ({
  kind: "activity", group, slotStart: at(minutes), slotMinutes: 5, events: 3, totalTokens: 60_000, inputTokens: 50_000, outputTokens: 10_000,
  cachedInputTokens: 0, reasoningOutputTokens: 0, recordedAt: at(-1), ...extra
});
const scan = (extra = {}) => ({ kind: "scan", group: "codex", at: at(-1), eventCount: 50, firstEventAt: at(-5000), lastEventAt: at(-1000), ...extra });
const corrReset = at(5 * 24 * 60); // mid-window: the window began two days ago
const plateauSamples = (from, to, used) => { const rows = []; for (let m = from; m <= to; m++) rows.push(snapshot(m, used, corrReset)); return rows; };
// 95% for a day, then 97% observed 40 minutes ago (lookahead ends 30 minutes ago), samples continuing to "now".
const symptom = () => [...plateauSamples(-1500, -41, 95), ...plateauSamples(-40, -1, 97)];

{
  // Used 95 -> 97 after a long quiet plateau, with a working local log reader and no activity: flagged, with evidence kept apart.
  const codexSnapshots = symptom();
  const report = analyzeQuotaIntegrity({ now, codexSnapshots, activityRecords: [slot(-4000), scan()] });
  const finding = report.anomalies.find((entry) => entry.type === "usage_increase_without_local_activity");
  assert.ok(finding, "the user's 5% -> 3% remaining symptom is detected");
  assert.equal(finding.severity, "warning");
  assert.equal(finding.confidence, "medium");
  assert.equal(finding.deltaPercent, 2);
  assert.equal(finding.local.primaryEvents, 0);
  assert.ok(finding.hypotheses.includes("other_device_or_surface") && finding.hypotheses.includes("local_logs_incomplete"));
  assert.match(finding.explanation, /does not show a provider-side defect/);
  assert.equal(report.summary.status, "attention");
}

{
  // Same step with local Codex activity inside the plateau: consistent with local use, not a finding.
  const codexSnapshots = symptom();
  const report = analyzeQuotaIntegrity({ now, codexSnapshots, activityRecords: [slot(-700), scan()] });
  assert.ok(!types(report).includes("usage_increase_without_local_activity"));
  const step = report.steps.find((entry) => entry.deltaPercent === 2);
  assert.equal(step.local.status, "activity_present");
  assert.equal(step.local.primaryTokens, 60_000);
}

{
  // Activity logged shortly after the observation (long response) still counts.
  const codexSnapshots = symptom();
  const report = analyzeQuotaIntegrity({ now, codexSnapshots, activityRecords: [slot(-35), scan()] });
  assert.equal(report.steps.find((entry) => entry.deltaPercent === 2).local.status, "activity_present");
}

{
  // Another local agent that may share the subscription is reported separately and does not trigger a finding.
  const codexSnapshots = symptom();
  const report = analyzeQuotaIntegrity({ now, codexSnapshots, activityRecords: [slot(-700, "openCode"), scan()] });
  const step = report.steps.find((entry) => entry.deltaPercent === 2);
  assert.equal(step.local.status, "shared_source_activity");
  assert.equal(step.local.sharedEvents, 3);
  assert.equal(step.local.primaryEvents, 0);
  assert.ok(!types(report).includes("usage_increase_without_local_activity"));
}

{
  // Spark has its own limit bucket: its activity neither explains nor is mixed into the primary count.
  const codexSnapshots = symptom();
  const report = analyzeQuotaIntegrity({ now, codexSnapshots, activityRecords: [slot(-700, "codexSpark"), scan()] });
  const step = report.steps.find((entry) => entry.deltaPercent === 2);
  assert.equal(step.local.separateEvents, 3);
  assert.equal(step.local.primaryEvents, 0);
  assert.ok(types(report).includes("usage_increase_without_local_activity"));
}

{
  // "No activity" requires evidence that local logs were being read; without it the answer is "cannot assess".
  const codexSnapshots = symptom();
  const noLogs = analyzeQuotaIntegrity({ now, codexSnapshots });
  assert.equal(noLogs.steps.find((entry) => entry.deltaPercent === 2).local.reason, "no_local_history");
  assert.ok(!types(noLogs).includes("usage_increase_without_local_activity"));
  assert.equal(noLogs.summary.status, "no_anomaly_detected", "an unassessable step is coverage information, not an alarm");

  const tooNew = analyzeQuotaIntegrity({ now, codexSnapshots, activityRecords: [scan({ at: at(-35) })] });
  assert.equal(tooNew.steps.find((entry) => entry.deltaPercent === 2).local.reason, "ingest_pending", "logs were not re-read after the step");

  const anotherProviderIsFresh = analyzeQuotaIntegrity({ now, codexSnapshots, activityRecords: [
    slot(-4000), scan({ at: at(-35) }),
    { kind: "scan", group: "claudeCode", at: at(-1), eventCount: 500, firstEventAt: at(-8000), lastEventAt: at(-100) }
  ] });
  assert.equal(anotherProviderIsFresh.steps.find((entry) => entry.deltaPercent === 2).local.reason, "ingest_pending", "a recent Claude scan must not make a stale Codex scan look current");

  const afterHistory = analyzeQuotaIntegrity({ now, codexSnapshots, activityRecords: [scan({ firstEventAt: at(-100) })] });
  assert.equal(afterHistory.steps.find((entry) => entry.deltaPercent === 2).local.reason, "before_local_history", "local logs begin after the interval started");
}

{
  // A collector gap inside the plateau lowers confidence and the finding stays informational.
  const codexSnapshots = [...plateauSamples(-1500, -400, 95), { kind: "gap", at: at(-390) }, ...plateauSamples(-300, -41, 95), ...plateauSamples(-40, -1, 97)];
  const report = analyzeQuotaIntegrity({ now, codexSnapshots, activityRecords: [slot(-4000), scan()] });
  const finding = report.anomalies.find((entry) => entry.type === "usage_increase_without_local_activity");
  assert.ok(finding);
  // The gap lies before the step pair itself, so the pair is clean; add one that overlaps the pair:
  const overlapping = analyzeQuotaIntegrity({ now, codexSnapshots: [...plateauSamples(-1500, -81, 95), ...plateauSamples(-40, -1, 97)], activityRecords: [slot(-4000), scan()] });
  const entry = overlapping.anomalies.find((item) => item.type === "usage_increase_without_local_activity");
  assert.equal(entry.confidence, "low", "a 40-minute silent gap straddles the step");
  assert.equal(entry.severity, "info");
  assert.equal(entry.context.overCollectionGap.kind, "no_observations");
}

{
  // Tokens-per-point is an estimate that only appears with enough comparable steps and is always low confidence.
  const codexSnapshots = [];
  const records = [scan({ firstEventAt: at(-9000) })];
  let used = 10;
  for (let step = 0; step < 10; step++) {
    const base = -3000 + step * 200;
    for (let m = base; m < base + 190; m++) codexSnapshots.push(snapshot(m, used, corrReset));
    used += 2;
    records.push(slot(base + 100, "codex", { totalTokens: 100_000 + step * 1000 }));
  }
  codexSnapshots.push(snapshot(-5, used, corrReset));
  records.push(slot(-120));
  const report = analyzeQuotaIntegrity({ now, codexSnapshots, activityRecords: records });
  assert.ok(report.estimates.tokensPerPercentPoint, "enough comparable steps");
  assert.equal(report.estimates.tokensPerPercentPoint.confidence, "low");
  assert.ok(report.estimates.tokensPerPercentPoint.median > 20_000 && report.estimates.tokensPerPercentPoint.median < 60_000);
  const few = analyzeQuotaIntegrity({ now, codexSnapshots: codexSnapshots.slice(-300), activityRecords: records });
  assert.equal(few.estimates.tokensPerPercentPoint, null);
}

{
  // Ledger series for Claude Code correlate against the Claude local group, and are labelled as not account scoped.
  const claude = (minutes, used) => ({ type: "quota_window", provider: "claudeCode", windowKey: "five_hour", capturedAt: at(minutes), usedPercent: used, resetsAt: at(120), windowMinutes: 300 });
  const records = [{ kind: "scan", group: "claudeCode", at: at(-1), eventCount: 20, firstEventAt: at(-9000), lastEventAt: at(-600) }];
  const report = analyzeQuotaIntegrity({ now, quotaEvents: [claude(-300, 10), claude(-200, 12), claude(-40, 15)], activityRecords: records });
  const finding = report.anomalies.find((entry) => entry.type === "usage_increase_without_local_activity");
  assert.ok(finding);
  assert.equal(finding.confidence, "low");
  assert.ok(finding.hypotheses.includes("ledger_not_account_scoped"));
  assert.equal(finding.source, "ledger");
}

{
  // Output never contains secrets, identifiers, paths, prompts or raw payloads.
  const codexSnapshots = [...plateauSamples(-1500, -41, 95), { ...snapshot(-40, 97, corrReset), accountId: "acct-SECRET", path: "C:\\Users\\someone\\.codex", prompt: "TOP SECRET PROMPT" }, ...plateauSamples(-39, -1, 97)];
  const report = analyzeQuotaIntegrity({ now, codexSnapshots, activityRecords: [slot(-4000, "codex", { sessionId: "sess-SECRET", model: "gpt-secret-model", path: "C:\\Users\\someone" }), scan()] });
  const text = JSON.stringify(report);
  for (const secret of ["acct-SECRET", "TOP SECRET PROMPT", "sess-SECRET", "gpt-secret-model", "C:\\\\Users", "hashed-account"]) assert.ok(!text.includes(secret), `leaked ${secret}`);
}

{
  // Two distinct findings of the same type one minute apart in ONE source must both survive de-duplication,
  // while the same event reported by both the ledger and the live snapshots is merged into one.
  const early = at(2 * 24 * 60);
  const both = analyzeQuotaIntegrity({ now, codexSnapshots: [
    creditSnapshot(-4, 90, reset, [{ key: "k1", status: "available", expiresAt: at(30 * 24 * 60) }]),
    creditSnapshot(-3, 60, early, [{ key: "k1", status: "available", expiresAt: at(30 * 24 * 60) }]),
    creditSnapshot(-2, 1, reset, [{ key: "k1", status: "redeemed" }])
  ] });
  const shifts = both.anomalies.filter((entry) => entry.type === "reset_deadline_changed_early");
  assert.equal(shifts.length, 2, "both early shifts are kept");
  assert.ok(shifts.some((entry) => entry.explainedBy?.code === "reset_credit_redeemed"), "the redemption is not swallowed by its neighbour");
  const twin = analyzeQuotaIntegrity({ now, quotaEvents: [event(-40, 80), event(-1, 20)], codexSnapshots: [snapshot(-30, 80), snapshot(-1, 20)] });
  assert.equal(twin.anomalies.filter((entry) => entry.type === "usage_rolled_back").length, 1, "ledger and snapshot twins merge");
  assert.equal(twin.anomalies.find((entry) => entry.type === "usage_rolled_back").source, "codex_snapshot");
}

// ---------------------------------------------------------------- round 3: coverage edge cases
// Timeline: the 2-point step is observed at -40 min, so the 10-minute lookahead ends at -30 min, which is exactly
// a 5-minute slot boundary because `now` is. A scan only vouches for slots that had already closed when it ran.
const stepOf = (report) => report.steps.find((entry) => entry.deltaPercent === 2);
const statusOf = (activityRecords, options = {}, snapshots = symptom()) => {
  const report = analyzeQuotaIntegrity({ now, codexSnapshots: snapshots, activityRecords }, options);
  const step = stepOf(report);
  return { report, step, status: step.local.status, reason: step.local.reason };
};
const scanAt = (millisecondsFromNow, extra = {}) => scan({ at: new Date(now + millisecondsFromNow).toISOString(), ...extra });

{
  // Scan freshness is judged against the END of the slot that contains the end of the lookahead window.
  assert.equal(statusOf([slot(-4000), scanAt(-30 * 60_000)]).status, "no_local_activity", "a scan exactly at the closed-slot boundary vouches for the interval");
  assert.equal(statusOf([slot(-4000), scanAt(-30 * 60_000 - 1)]).reason, "ingest_pending", "one millisecond earlier it does not");
  // Observation at -37 min: the lookahead ends at -27 min, inside the slot ending at -25 min.
  const midSlot = [...plateauSamples(-1500, -38, 95), ...plateauSamples(-37, -1, 97)];
  assert.equal(statusOf([slot(-4000), scanAt(-27 * 60_000)], {}, midSlot).reason, "ingest_pending", "being past the lookahead end is not enough while its slot is still open");
  assert.equal(statusOf([slot(-4000), scanAt(-25 * 60_000 - 1)], {}, midSlot).reason, "ingest_pending");
  assert.equal(statusOf([slot(-4000), scanAt(-25 * 60_000)], {}, midSlot).status, "no_local_activity", "once the slot has closed, the scan counts");
  // The late event in the last slot of the lookahead is still counted even though it can be after the window end.
  assert.equal(statusOf([slot(-28, "codex"), scanAt(-1 * 60_000)], {}, midSlot).status, "activity_present");
}

{
  // A scan time that is implausible for the analysis clock never counts as coverage.
  assert.equal(statusOf([slot(-4000), scanAt(4 * 60_000)]).status, "no_local_activity", "a small amount of clock skew is tolerated");
  const skewed = statusOf([slot(-4000), scanAt(30 * 60_000)]);
  assert.equal(skewed.status, "not_assessable");
  assert.equal(skewed.reason, "ingest_pending", "a scan stamped in the future is not coverage");
  assert.ok(!types(skewed.report).includes("usage_increase_without_local_activity"));
  assert.equal(skewed.report.coverage.tokenActivity.lastIngestAt, at(-1), "the implausible +30 minute scan time is ignored in favour of the plausible record when reporting the last refresh");
}

{
  // The "only another local agent" label is an absence claim about the primary logs: it needs the same coverage.
  const openCode = slot(-35, "openCode");
  const stale = statusOf([slot(-4000), scanAt(-35 * 60_000), openCode, { kind: "scan", group: "openCode", at: at(-1), eventCount: 9, firstEventAt: at(-9000), lastEventAt: at(-35) }]);
  assert.equal(stale.status, "not_assessable", "a stale primary scan must not be turned into 'only another agent'");
  assert.equal(stale.reason, "ingest_pending");
  const noHistory = statusOf([openCode, { kind: "scan", group: "openCode", at: at(-1), eventCount: 9, firstEventAt: at(-9000), lastEventAt: at(-35) }]);
  assert.equal(noHistory.reason, "no_local_history", "no primary history at all: still not assessable");
  const fresh = statusOf([slot(-4000), scanAt(-1 * 60_000), openCode, { kind: "scan", group: "openCode", at: at(-1), eventCount: 9, firstEventAt: at(-9000), lastEventAt: at(-35) }]);
  assert.equal(fresh.status, "shared_source_activity", "with proven primary coverage the label is allowed");
}

{
  // Another agent that shares the subscription and has ever produced activity must itself have been read recently.
  const shared = (atMinutes) => ({ kind: "scan", group: "openCode", at: at(atMinutes), eventCount: 9, firstEventAt: at(-9000), lastEventAt: at(-3000) });
  assert.equal(statusOf([slot(-4000), scanAt(-60_000), shared(-35)]).reason, "ingest_pending", "stale shared-agent scan blocks an absence claim");
  assert.equal(statusOf([slot(-4000), scanAt(-60_000), shared(-1)]).status, "no_local_activity", "a fresh one does not");
  assert.equal(statusOf([slot(-4000), scanAt(-60_000)]).status, "no_local_activity", "a shared agent that never produced activity is ignored");
}

{
  // Every primary group must be covered; one fresh group never stands in for another (multi-group providers).
  const options = { activitySources: { codex: { primary: ["codex", "codexSpark"], shared: [], separate: [] } } };
  const alt = (atMinutes, extra = {}) => ({ kind: "scan", group: "codexSpark", at: at(atMinutes), eventCount: 5, firstEventAt: at(-5000), lastEventAt: at(-1000), ...extra });
  assert.equal(statusOf([slot(-4000), scanAt(-60_000)], options).reason, "no_local_history", "second primary group missing");
  assert.equal(statusOf([slot(-4000), scanAt(-60_000), alt(-35)], options).reason, "ingest_pending", "second primary group stale");
  assert.equal(statusOf([slot(-4000), scanAt(-35 * 60_000), alt(-1)], options).reason, "ingest_pending", "first primary group stale");
  assert.equal(statusOf([slot(-4000), scanAt(-60_000), alt(-1, { firstEventAt: at(-100) })], options).reason, "before_local_history", "second group's logs begin later than the interval");
  assert.equal(statusOf([slot(-4000), scanAt(-60_000), alt(-1)], options).status, "no_local_activity");
}

{
  // Damaged scan records: an unknown start of history, or no usable scan time, can never support an absence claim.
  assert.equal(statusOf([scan({ firstEventAt: null })]).reason, "before_local_history", "damaged scan with no slots: start of history unknown");
  assert.equal(statusOf([slot(-4000), scan({ firstEventAt: null })]).status, "no_local_activity", "recorded slots from before the interval prove history began earlier");
  const unparseable = statusOf([slot(-4000), scan({ at: "not a date" })]);
  assert.deepEqual([unparseable.status, unparseable.reason], ["not_assessable", "ingest_pending"], "an unparseable scan record is dropped and slots alone give no freshness proof");
  assert.equal(statusOf([slot(-4000), scan({ eventCount: 0, firstEventAt: at(-5000) })]).reason, "ingest_pending", "slots without a usable scan heartbeat give no freshness proof");
  assert.equal(statusOf([scan({ at: at(-1) })].filter((r) => r.kind === "scan").map((r) => ({ ...r, eventCount: 0 }))).reason, "no_local_history", "a scan that saw no events is not history");
}

{
  // A record dated after the analysis clock must not hide staleness or fake a rollback.
  const real = [snapshot(-200, 40), snapshot(-190, 40), snapshot(24 * 60, 40)];
  const staleView = analyzeQuotaIntegrity({ now, codexSnapshots: real });
  assert.equal(staleView.freshness.codex.status, "stale", "the real last sample is 190 minutes old");
  assert.equal(staleView.coverage.futureDatedRecords, 1);
  assert.equal(staleView.coverage.codexLastLiveSampleAt, at(-190));
  assert.ok(types(staleView).includes("stale_codex_snapshot"));
  const ledger = analyzeQuotaIntegrity({ now, quotaEvents: [event(-300, 40), event(24 * 60, 90), event(-10, 41)] });
  assert.equal(ledger.coverage.futureDatedRecords, 1);
  assert.ok(!types(ledger).includes("usage_rolled_back"), "the later real row is not compared with the bogus future row");
  assert.equal(ledger.history.windows[0].lastUsedPercent, 41, "the latest value shown is the real one");
  const failure = analyzeQuotaIntegrity({ now, codexSnapshots: [snapshot(-3, 40), { kind: "gap", at: at(5 * 24 * 60) }] });
  assert.equal(failure.freshness.codex.status, "live", "a future-dated failure row cannot make a live collector look unavailable");
}

// ---------------------------------------------------------------- round 3: invariant fuzz
// Whatever the stored coverage records look like (stale, missing, skewed, damaged), a finding that claims there was
// "no local activity" must be backed by fresh, plausible, complete coverage and an empty interval. Independent oracle.
{
  let seed = 20261015;
  const random = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = (list) => list[Math.floor(random() * list.length)];
  const minuteValues = [-5000, -2900, -1400, -100, -60, -41, -40, -39, -36, -35, -31, -30, -29, -26, -25, -24, -10, -1, 0, 2, 4, 6, 30, 600];
  const timeValue = () => pick([() => at(pick(minuteValues)), () => "garbage", () => null, () => 12345, () => true, () => [at(-1)], () => at(pick(minuteValues)) ]) ();
  const groups = ["codex", "openCode", "claudeCode", "codexSpark"];
  let findings = 0, unassessable = 0, assessable = 0;
  for (let round = 0; round < 600; round++) {
    const records = [];
    // Half of the rounds start from a plausible primary scan (random freshness, around the boundary) so the
    // finding branch is exercised often; noise of every kind is layered on top in all rounds.
    if (random() < 0.5) records.push({ kind: "scan", group: "codex", at: at(pick([-35, -31, -30, -29, -26, -25, -1, 2, 30])), eventCount: 7, firstEventAt: at(pick([-5000, -5000, -100])), lastEventAt: at(-3000) });
    if (random() < 0.3) records.push({ kind: "scan", group: "openCode", at: at(pick([-35, -1])), eventCount: 3, firstEventAt: at(-5000), lastEventAt: at(-3000) });
    for (let i = 0, n = Math.floor(random() * 4); i < n; i++) {
      const group = pick(groups);
      if (random() < 0.5) records.push({ kind: "scan", group, at: timeValue(), eventCount: pick([0, 1, 7, "3", true, [4], -2, 1e300]), firstEventAt: timeValue(), lastEventAt: timeValue() });
      else records.push({ kind: "activity", group, slotStart: at(pick(minuteValues)), slotMinutes: pick([5, 5, 5, 1, "5", true, 60]), events: pick([1, 2, 0, true, "x"]), totalTokens: pick([100, true, [9], 1e300, "40"]), recordedAt: timeValue() });
    }
    const report = analyzeQuotaIntegrity({ now, codexSnapshots: symptom(), activityRecords: records });
    const step = stepOf(report);
    if (step.local.status === "not_assessable") unassessable++; else assessable++;
    const finding = report.anomalies.find((entry) => entry.type === "usage_increase_without_local_activity");
    assert.equal(Boolean(finding), step.local.status === "no_local_activity", "a finding exists exactly when the verdict is 'no local activity'");
    if (!finding) continue;
    findings++;
    const valid = foldActivityRecords(records);
    const scans = new Map(valid.scans.map((entry) => [entry.group, entry]));
    const observed = Date.parse(finding.observedAt);
    const toMs = observed + 10 * 60_000;
    const required = Math.ceil(toMs / 300_000) * 300_000;
    const fromMs = observed - finding.intervalMinutes * 60_000 - 5 * 60_000;
    const codexScan = scans.get("codex");
    assert.ok(codexScan && codexScan.eventCount > 0, `round ${round}: a usable primary scan with history exists`);
    assert.ok(Date.parse(codexScan.at) >= required && Date.parse(codexScan.at) <= now + 5 * 60_000, `round ${round}: primary scan is fresh and plausible`);
    assert.ok(codexScan.firstEventAt && Date.parse(codexScan.firstEventAt) <= fromMs, `round ${round}: history provably starts before the interval`);
    const openCodeScan = scans.get("openCode");
    const openCodeSlots = valid.slots.filter((entry) => entry.group === "openCode");
    if ((openCodeScan && openCodeScan.eventCount > 0) || openCodeSlots.length) assert.ok(openCodeScan && Date.parse(openCodeScan.at) >= required && Date.parse(openCodeScan.at) <= now + 5 * 60_000, `round ${round}: a shared agent with history was read after the interval`);
    for (const entry of valid.slots.filter((candidate) => candidate.group === "codex" || candidate.group === "openCode")) {
      const start = Date.parse(entry.slotStart);
      assert.ok(!(start + entry.slotMinutes * 60_000 > fromMs && start <= toMs), `round ${round}: no recorded ${entry.group} activity overlaps the interval`);
    }
  }
  assert.ok(findings > 30 && unassessable > 100 && assessable > 100, `the fuzz exercised both outcomes (${findings} findings, ${unassessable} not assessable)`);
}

// ---------------------------------------------------------------- Go plan: 30-day windows, several window types
const DAY = 24 * 60;
const GO = "window_43200m";
const monthlyReset = at(15 * DAY); // the 30-day window began 15 days ago
const monthlySample = (minutes, usedPercent, resetsAt = monthlyReset, accountKey = "hashed-account-a", extra = {}) => ({
  kind: "sample", source: "live", at: at(minutes), accountKey, planType: "go", window: { usedPercent, resetsAt, windowMinutes: 43200 }, ...extra
});
const monthlySeries = (from, to, used, resetsAt = monthlyReset, accountKey = "hashed-account-a") => { const rows = []; for (let m = from; m <= to; m++) rows.push(monthlySample(m, used, resetsAt, accountKey)); return rows; };
const goSymptom = () => [...monthlySeries(-1500, -41, 40), ...monthlySeries(-40, -1, 42)];
const goScan = (extra = {}) => scan({ firstEventAt: at(-30 * DAY), ...extra });
const goStep = (report) => report.steps.find((entry) => entry.windowKey === GO && entry.deltaPercent === 2);

{
  // The exact shape that was observed (used 37 % of a 30-day window, no secondary) is analysed as its own window type.
  const report = analyzeQuotaIntegrity({ now, codexSnapshots: [...monthlySeries(-30, -2, 37), monthlySample(-1, 37)] });
  assert.equal(report.coverage.codexLiveSamples, 30);
  assert.equal(report.coverage.codexWeeklySamples, 0, "nothing here is weekly");
  assert.deepEqual(report.coverage.codexWindowTypes, [GO]);
  assert.equal(report.freshness.codex.status, "live", "a monthly-only account is a live collector, not a failing one");
  assert.ok(!types(report).includes("no_live_codex_samples") && !types(report).includes("collector_gap"));
  assert.equal(report.summary.status, "no_anomaly_detected");
  assert.equal(report.history.codexWeekly.points.length, 0, "the weekly chart is never fed by a monthly series");
  const listed = report.history.windows.find((entry) => entry.windowKey === GO);
  assert.deepEqual([listed.source, listed.windowLabel, listed.lastUsedPercent, listed.observations], ["codex_snapshot", "30d", 37, 30], "the window is listed with its real duration");
  assert.ok(!JSON.stringify(report).includes("weekly") || report.history.codexWeekly, "no field calls the 30-day window weekly");
  assert.ok(report.history.windows.every((entry) => entry.windowKey !== "weekly"));
}

{
  // Local-activity comparison works on the 30-day series, with the window start 15 days back as the conservative bound.
  const none = analyzeQuotaIntegrity({ now, codexSnapshots: goSymptom(), activityRecords: [slot(-40 * DAY), goScan()] });
  const finding = none.anomalies.find((entry) => entry.type === "usage_increase_without_local_activity");
  assert.ok(finding, "a 2-point rise in the 30-day window with covered logs and no activity is reported");
  assert.equal(finding.windowKey, GO);
  assert.equal(finding.intervalBasis, "window_start");
  assert.ok(finding.intervalMinutes > 14 * DAY, "the interval runs back to the start of the 30-day window");
  assert.equal(goStep(none).local.status, "no_local_activity");
  // Activity 12 days ago is inside this window (it began 15 days ago) and must be found; it would be invisible to a 7-day view.
  const found = analyzeQuotaIntegrity({ now, codexSnapshots: goSymptom(), activityRecords: [slot(-12 * DAY), goScan()] });
  assert.equal(goStep(found).local.status, "activity_present");
  assert.ok(!types(found).includes("usage_increase_without_local_activity"));
  // Activity just before the window began is outside it.
  assert.equal(goStep(analyzeQuotaIntegrity({ now, codexSnapshots: goSymptom(), activityRecords: [slot(-16 * DAY), goScan()] })).local.status, "no_local_activity");
}

{
  // An account that reports BOTH a weekly and a monthly window (interleaved, as if the collector alternated): two
  // independent series. A 90 % weekly value is never compared with a 37 % monthly one.
  const rows = [];
  for (let m = -1500; m <= -1; m++) {
    rows.push(snapshot(m, m < -40 ? 90 : 92, corrReset, "hashed-account-a"));
    rows.push(monthlySample(m, m < -40 ? 37 : 39, monthlyReset, "hashed-account-a"));
  }
  const report = analyzeQuotaIntegrity({ now, codexSnapshots: rows, activityRecords: [slot(-40 * DAY), goScan()] });
  assert.ok(!types(report).includes("usage_rolled_back") && !types(report).includes("reset_deadline_changed_early"), "no cross-window comparison");
  assert.equal(report.coverage.codexLiveSamples, 3000);
  assert.equal(report.coverage.codexWeeklySamples, 1500);
  assert.deepEqual(report.coverage.codexWindowTypes, ["weekly", GO]);
  assert.deepEqual(report.steps.map((entry) => entry.windowKey).sort(), ["weekly", GO], "one rise per window, each in its own series");
  assert.deepEqual(report.history.codexWeekly.points.map((point) => point.usedPercent), [90, 92], "the weekly chart holds weekly values only");
  assert.deepEqual(report.history.windows.map((entry) => [entry.windowKey, entry.windowLabel, entry.lastUsedPercent]).sort(), [["weekly", "7d", 92], [GO, "30d", 39]]);
  // Which sample is last does not matter: the weekly chart follows the latest WEEKLY series.
  const monthlyLast = analyzeQuotaIntegrity({ now, codexSnapshots: [...rows.slice(0, -2), snapshot(-1, 92, corrReset), monthlySample(-0.5, 39)] });
  assert.ok(monthlyLast.history.codexWeekly.points.length >= 2, "the weekly chart survives a monthly sample being the newest");
}

{
  // The same account changes window type (for example a plan change): the two periods are separate series, not a rollback.
  const rows = [...plateauSamples(-3000, -1501, 95), ...monthlySeries(-1500, -1, 5)];
  const report = analyzeQuotaIntegrity({ now, codexSnapshots: rows });
  assert.ok(!types(report).includes("usage_rolled_back"), "95 % weekly then 5 % monthly is not a drop");
  assert.ok(!types(report).includes("reset_deadline_changed_early"));
  assert.ok(!types(report).includes("account_changed"), "a window-type change is not an account change");
  assert.equal(report.coverage.codexAccountChanges, 0);
  assert.deepEqual(report.coverage.codexWindowTypes, ["weekly", GO]);
  assert.equal(report.history.codexWeekly.points.at(-1).usedPercent, 95, "the weekly chart keeps the old weekly history");
}

{
  // Account switching with monthly windows: one change, values never compared across accounts or window types.
  const monthlyToMonthly = analyzeQuotaIntegrity({ now, codexSnapshots: [...monthlySeries(-200, -101, 60, monthlyReset, "hashed-account-a"), ...monthlySeries(-100, -1, 10, at(25 * DAY), "hashed-account-b")] });
  assert.equal(monthlyToMonthly.anomalies.filter((entry) => entry.type === "account_changed").length, 1);
  assert.ok(!types(monthlyToMonthly).includes("usage_rolled_back") && !types(monthlyToMonthly).includes("reset_deadline_changed_early"));
  assert.equal(monthlyToMonthly.anomalies.find((entry) => entry.type === "account_changed").windowKey, GO);
  const weeklyToMonthly = analyzeQuotaIntegrity({ now, codexSnapshots: [...plateauSamples(-200, -101, 90), ...monthlySeries(-100, -1, 10, at(25 * DAY), "hashed-account-b")].map((row) => (row.window.windowMinutes === 10080 ? { ...row, accountKey: "hashed-account-a" } : row)) });
  assert.equal(weeklyToMonthly.coverage.codexAccountChanges, 1);
  assert.ok(!JSON.stringify(monthlyToMonthly).includes("hashed-account"));
}

{
  // Reset credits are attributed within each window's own series. An interleaved monthly sample cannot break or steal a weekly redemption.
  const early = at(2 * DAY);
  const weeklyRedemption = analyzeQuotaIntegrity({ now, codexSnapshots: [
    creditSnapshot(-4, 90, early, [{ key: "k1", status: "available", expiresAt: at(30 * DAY) }]),
    monthlySample(-3, 37), // another window reported in between
    creditSnapshot(-2, 1, reset, [{ key: "k1", status: "redeemed" }])
  ] });
  const shift = weeklyRedemption.anomalies.find((entry) => entry.type === "reset_deadline_changed_early");
  assert.deepEqual(shift.explainedBy, { code: "reset_credit_redeemed", confidence: "confirmed" });
  assert.equal(shift.windowKey, "weekly");
  assert.ok(weeklyRedemption.anomalies.every((entry) => entry.windowKey !== GO || entry.severity === "info"), "the monthly sample caused no finding");
  // A redemption in a 30-day window explains that window's early reset the same way.
  const credit = (minutes, used, resetsAt, items) => monthlySample(minutes, used, resetsAt, "hashed-account-a", { credits: { availableCount: items.filter((c) => c.status === "available").length, complete: true, items } });
  const monthlyRedemption = analyzeQuotaIntegrity({ now, codexSnapshots: [
    credit(-4, 60, at(10 * DAY), [{ key: "m1", status: "available", expiresAt: at(30 * DAY) }]),
    credit(-2, 2, at(30 * DAY), [{ key: "m1", status: "redeemed" }])
  ] });
  const monthlyShift = monthlyRedemption.anomalies.find((entry) => entry.type === "reset_deadline_changed_early");
  assert.equal(monthlyShift.windowKey, GO);
  assert.equal(monthlyShift.severity, "info");
  assert.deepEqual(monthlyShift.explainedBy, { code: "reset_credit_redeemed", confidence: "confirmed" });
  assert.equal(monthlyShift.resetCause.type, "manual");
  // The same early reset with no credit used stays a warning in the 30-day window.
  const unexplained = analyzeQuotaIntegrity({ now, codexSnapshots: [credit(-4, 60, at(10 * DAY), []), credit(-2, 2, at(30 * DAY), [])] });
  assert.equal(unexplained.anomalies.find((entry) => entry.type === "reset_deadline_changed_early").severity, "warning");
  assert.ok(!JSON.stringify(weeklyRedemption).includes("k1") && !JSON.stringify(monthlyRedemption).includes("m1"));
}

{
  // The ledger names this window exactly like the snapshots do, so one event seen by both sources is ONE finding.
  const ledger = (minutes, used) => ({ type: "quota_window", provider: "codex", windowKey: GO, windowMinutes: 43200, capturedAt: at(minutes), usedPercent: used, resetsAt: monthlyReset });
  const report = analyzeQuotaIntegrity({ now, quotaEvents: [ledger(-40, 50), ledger(-1, 30)], codexSnapshots: [monthlySample(-40, 50), monthlySample(-1, 30)] });
  const rollbacks = report.anomalies.filter((entry) => entry.type === "usage_rolled_back");
  assert.equal(rollbacks.length, 1);
  assert.equal(rollbacks[0].source, "codex_snapshot");
  assert.equal(report.history.windows.filter((entry) => entry.windowKey === GO).length, 1, "one row per window in the list");
  // Ledger steps are skipped only for windows the live snapshots also cover.
  const claudeLike = analyzeQuotaIntegrity({ now, quotaEvents: [{ ...ledger(-300, 10), windowKey: "weekly" }, { ...ledger(-200, 12), windowKey: "weekly" }], codexSnapshots: [monthlySample(-300, 10), monthlySample(-1, 12)], activityRecords: [slot(-40 * DAY), goScan()] });
  assert.ok(claudeLike.steps.some((entry) => entry.source === "ledger" && entry.windowKey === "weekly"), "a weekly ledger series is still analysed when the snapshots only cover another window");
}

{
  // Activity coverage cannot reach back further than the ledger keeps slots, or further than the reader loaded.
  const old = [];
  for (let m = 80 * DAY; m >= 50 * DAY; m -= 5) old.push(snapshot(-m, m > 70 * DAY ? 10 : 12, at(-45 * DAY)));
  const tooOld = analyzeQuotaIntegrity({ now, codexSnapshots: old, activityRecords: [slot(-1), scan({ firstEventAt: at(-100 * DAY) })] });
  const oldStep = tooOld.steps.find((entry) => entry.deltaPercent === 2);
  assert.deepEqual([oldStep.local.status, oldStep.local.reason], ["not_assessable", "before_local_history"], "no 'no activity' claim for a period the ledger has already discarded");
  assert.ok(!types(tooOld).includes("usage_increase_without_local_activity"));
  const base = analyzeQuotaIntegrity({ now, codexSnapshots: symptom(), activityRecords: [slot(-4000), scan()], activityLoadedFromMs: at(-4000) });
  assert.equal(stepOf(base).local.status, "no_local_activity", "loaded far enough back");
  const shallow = analyzeQuotaIntegrity({ now, codexSnapshots: symptom(), activityRecords: [slot(-4000), scan()], activityLoadedFromMs: at(-1000) });
  assert.deepEqual([stepOf(shallow).local.status, stepOf(shallow).local.reason], ["not_assessable", "before_local_history"], "the reader did not load the start of the interval");
}

{
  // Failure records carry a fixed reason; anything else is dropped. A Go account whose snapshots could not be recorded
  // (the earlier bug) shows its reasons instead of an unexplained gap.
  const gap = (minutes, reason) => ({ kind: "gap", at: at(minutes), status: "unavailable", ...(reason === undefined ? {} : { reason }) });
  const rows = [-60, -54.9, -49.8, -44.7].map((m) => gap(m, "no_account_id")).concat([gap(-39.6, "request_failed"), gap(-34.5, "secret text C:\\Users\\x"), gap(-29.4)]);
  const outage = analyzeQuotaIntegrity({ now, codexSnapshots: rows });
  const incident = outage.anomalies.find((entry) => entry.type === "collector_gap");
  assert.equal(incident.ongoing, true);
  assert.deepEqual(incident.failureReasons, { no_account_id: 4, request_failed: 1 });
  assert.equal(incident.failureRecords, 7);
  assert.equal(incident.windowKey, "unknown");
  assert.deepEqual(outage.gaps[0].failureReasons, { no_account_id: 4, request_failed: 1 });
  assert.ok(!JSON.stringify(outage).includes("secret text"), "only fixed reason codes are accepted");
  // After the collector recovers on a monthly window, the incident belongs to that window.
  const recovered = analyzeQuotaIntegrity({ now, codexSnapshots: [monthlySample(-70, 37), ...rows, monthlySample(-1, 37)] });
  const done = recovered.anomalies.find((entry) => entry.type === "collector_gap");
  assert.equal(done.windowKey, GO);
  assert.equal(done.recoveredAt, at(-1));
  assert.equal(recovered.freshness.codex.status, "live");
  // The incident belongs to the window the collector was reporting when it stopped, not whatever the newest sample is.
  const switched = analyzeQuotaIntegrity({ now, codexSnapshots: [monthlySample(-70, 37), ...rows, snapshot(-1, 50, corrReset)] });
  assert.equal(switched.anomalies.find((entry) => entry.type === "collector_gap").windowKey, GO);
  const silent = analyzeQuotaIntegrity({ now, codexSnapshots: [monthlySample(-600, 37), snapshot(-1, 50, corrReset)] });
  assert.equal(silent.anomalies.find((entry) => entry.type === "observation_gap").windowKey, GO, "same for an interval with no records at all");
  // A snapshot whose window duration is not a number is not a window.
  const text = analyzeQuotaIntegrity({ now, codexSnapshots: [{ ...monthlySample(-1, 37), window: { usedPercent: 37, resetsAt: monthlyReset, windowMinutes: "43200" } }] });
  assert.equal(text.coverage.codexLiveSamples, 0);
}

console.log("Quota integrity v2: incidents, silent gaps, rolling deadlines, credits, accounts, correlation, bounds and privacy passed.");

