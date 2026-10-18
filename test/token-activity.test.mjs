import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { KNOWN_GROUPS, buildActivity, parseActivityRecord, foldActivityRecords, planActivityWrites, compactActivityRecords, indexActivity, summarizeWindow } = require("../lib/token-activity.js");

const now = Date.parse("2026-10-14T10:00:00.000Z");
const ms = (minutes) => now + minutes * 60_000;
const event = (minutes, total, extra = {}) => ({
  providerId: "codex", sourceId: "src", timestampMs: ms(minutes), model: "secret-model-name",
  usage: { input_tokens: total * 0.8, output_tokens: total * 0.2, total_tokens: total },
  metadata: { sourceGroupId: "codex" }, evidence: { realpath: "C:\\Users\\someone\\.codex\\session.jsonl", sessionId: "secret-session" },
  attribution: { accountId: "gpt-0123456789abcdef" }, ...extra
});

{
  // Events become counters per group and 5-minute slot; duplicates are counted once; Spark stays a separate group.
  const { slots, scans } = buildActivity([
    event(-61, 1000), event(-60, 2000), event(-60, 2000), event(-58, 500),
    event(-10, 700, { metadata: { sourceGroupId: "codexSpark" } }),
    event(-9, 0), // zero tokens: ignored
    { providerId: "codex", timestampMs: "nope", usage: { total_tokens: 5 } },
    event(30, 99) // in the future: ignored
  ], { now });
  const records = [...slots.values()];
  const first = records.find((r) => r.group === "codex" && r.slotStart === new Date(ms(-65)).toISOString());
  assert.deepEqual([first.events, first.totalTokens], [1, 1000], "event at -61 min lands in the slot starting at -65 min");
  const next = records.find((r) => r.group === "codex" && r.slotStart === new Date(ms(-60)).toISOString());
  assert.deepEqual([next.events, next.totalTokens], [2, 2500], "duplicate removed; -58 min shares the slot with -60 min");
  assert.ok(records.some((r) => r.group === "codexSpark"));
  assert.equal(scans.find((s) => s.group === "codex").eventCount, 3);
  const text = JSON.stringify({ slots: records, scans });
  for (const secret of ["secret-model-name", "secret-session", "someone", "gpt-0123456789abcdef", "realpath"]) assert.ok(!text.includes(secret), `leaked ${secret}`);
}

{
  // Retention bounds slots but the scan summary still describes the full log range.
  const old = event(-40 * 24 * 60, 100);
  const { slots, scans } = buildActivity([old, event(-10, 100)], { now });
  assert.equal(slots.size, 1);
  assert.equal(scans[0].eventCount, 2);
  assert.equal(scans[0].firstEventAt, new Date(old.timestampMs).toISOString());
}

{
  // Stored records are validated; unknown and unsafe fields are dropped.
  assert.equal(parseActivityRecord({ kind: "activity", group: "bad group!", slotStart: new Date(now).toISOString(), slotMinutes: 5, events: 1 }), null);
  assert.equal(parseActivityRecord({ kind: "activity", group: "codex", slotStart: "x", slotMinutes: 5, events: 1 }), null);
  assert.equal(parseActivityRecord({ kind: "activity", group: "codex", slotStart: new Date(now).toISOString(), slotMinutes: 5, events: 0 }), null);
  assert.equal(parseActivityRecord({ kind: "other" }), null);
  const clean = parseActivityRecord({ kind: "activity", group: "codex", slotStart: new Date(now).toISOString(), slotMinutes: 5, events: 2, totalTokens: 10, prompt: "secret", path: "C:\\x" });
  assert.ok(!("prompt" in clean) && !("path" in clean));
  const malformedCounters = parseActivityRecord({ kind: "activity", group: "codex", slotStart: new Date(now).toISOString(), slotMinutes: 5, events: 1, totalTokens: true, inputTokens: [900], outputTokens: "50", cachedInputTokens: false, reasoningOutputTokens: {} });
  assert.deepEqual([malformedCounters.totalTokens, malformedCounters.inputTokens, malformedCounters.outputTokens, malformedCounters.cachedInputTokens, malformedCounters.reasoningOutputTokens], [0, 0, 50, 0, 0], "booleans and arrays cannot be coerced into fake token counters");
}

{
  // Folding keeps the larger slot, so a provider deleting its own logs cannot erase recorded activity.
  const full = { kind: "activity", group: "codex", slotStart: new Date(ms(-30)).toISOString(), slotMinutes: 5, events: 4, totalTokens: 400, recordedAt: new Date(ms(-20)).toISOString() };
  const shrunk = { ...full, events: 1, totalTokens: 100, recordedAt: new Date(ms(-5)).toISOString() };
  const folded = foldActivityRecords([full, shrunk, { kind: "scan", group: "codex", at: new Date(ms(-5)).toISOString(), eventCount: 1, firstEventAt: new Date(ms(-100)).toISOString() },
    { kind: "scan", group: "codex", at: new Date(ms(-50)).toISOString(), eventCount: 9, firstEventAt: new Date(ms(-500)).toISOString() }]);
  assert.equal(folded.slots[0].totalTokens, 400);
  assert.equal(folded.scans[0].firstEventAt, new Date(ms(-500)).toISOString(), "earliest event ever seen is kept");
  assert.equal(folded.scans[0].at, new Date(ms(-5)).toISOString(), "newest scan time is kept");
}

{
  // Write planning is incremental: nothing new means nothing written; growth and heartbeats are written.
  const known = { slots: new Map(), scans: new Map() };
  const activity = buildActivity([event(-30, 1000)], { now });
  const first = planActivityWrites(activity, known, now);
  assert.equal(first.length, 2, "one slot and one scan record");
  assert.equal(planActivityWrites(activity, known, now + 60_000).length, 0, "unchanged data, heartbeat not due");
  assert.equal(planActivityWrites(activity, known, now + 16 * 60_000).length, 1, "heartbeat due after 15 minutes");
  const grown = buildActivity([event(-30, 1000), event(-29, 500)], { now });
  assert.equal(planActivityWrites(grown, known, now + 17 * 60_000).filter((r) => r.kind === "activity").length, 1, "slot grew");
}

{
  // Compaction drops expired slots and superseded duplicates.
  const rows = [
    { kind: "activity", group: "codex", slotStart: new Date(ms(-40 * 24 * 60)).toISOString(), slotMinutes: 5, events: 1, totalTokens: 1 },
    { kind: "activity", group: "codex", slotStart: new Date(ms(-30)).toISOString(), slotMinutes: 5, events: 1, totalTokens: 10 },
    { kind: "activity", group: "codex", slotStart: new Date(ms(-30)).toISOString(), slotMinutes: 5, events: 2, totalTokens: 20 },
    { kind: "scan", group: "codex", at: new Date(ms(-1)).toISOString(), eventCount: 3 }
  ];
  const compact = compactActivityRecords(rows, now);
  assert.equal(compact.filter((r) => r.kind === "activity").length, 1);
  assert.equal(compact.find((r) => r.kind === "activity").totalTokens, 20);
  assert.equal(compact.filter((r) => r.kind === "scan").length, 1);
}

{
  // Window queries have one-slot resolution and keep groups apart.
  const rows = [
    { kind: "activity", group: "codex", slotStart: new Date(ms(-20)).toISOString(), slotMinutes: 5, events: 2, totalTokens: 200 },
    { kind: "activity", group: "codex", slotStart: new Date(ms(-5)).toISOString(), slotMinutes: 5, events: 1, totalTokens: 50 },
    { kind: "activity", group: "openCode", slotStart: new Date(ms(-5)).toISOString(), slotMinutes: 5, events: 7, totalTokens: 700 }
  ];
  const index = indexActivity(foldActivityRecords(rows));
  const window = summarizeWindow(index, ["codex", "openCode"], ms(-10), ms(0));
  assert.equal(window.byGroup.codex.events, 1);
  assert.equal(window.byGroup.openCode.totalTokens, 700);
  assert.equal(summarizeWindow(index, ["codex"], ms(-15), ms(-10)).events, 0, "an interval between slots is empty");
  assert.equal(summarizeWindow(index, ["codex"], ms(-17), ms(-14)).events, 2, "an interval touching a slot overlaps it");
}

{
  // Provider logs are untrusted JSON. The shared usage normalizer would coerce true -> 1 and [900] -> 900, so the
  // ledger validates counters itself: an event with malformed counters still counts as activity (something
  // happened then) but contributes no tokens, which can only make "no local activity" harder to conclude.
  const malformed = [
    { total_tokens: true }, { input_tokens: [900], output_tokens: 5 }, { total_tokens: { value: 5 } },
    { total_tokens: 1e300 }, { input_tokens: -5, output_tokens: 20 }, { total_tokens: "  " }, { total_tokens: "abc" }, { total_tokens: Infinity }
  ];
  for (const [index, usage] of malformed.entries()) {
    const { slots, scans } = buildActivity([event(-30, 0, { usage, timestampMs: ms(-30) + index })], { now });
    const records = [...slots.values()];
    assert.equal(records.length, 1, `malformed counters #${index} still count as activity`);
    assert.deepEqual([records[0].events, records[0].totalTokens, records[0].inputTokens, records[0].outputTokens], [1, 0, 0, 0], `malformed counters #${index} contribute no tokens`);
    assert.equal(scans[0].eventCount, 1);
  }
  // A missing usage object is malformed too; well-formed numeric strings are accepted; zero-token events are skipped.
  assert.equal(buildActivity([event(-30, 0, { usage: null }), event(-29, 0, { usage: undefined })], { now }).slots.size, 0, "no usage object at all is not a token event");
  for (const usage of ["garbage", [5], true, 42]) {
    const only = [...buildActivity([event(-30, 0, { usage })], { now }).slots.values()];
    assert.deepEqual([only.length, only[0]?.events, only[0]?.totalTokens], [1, 1, 0], `a usage value of the wrong type (${JSON.stringify(usage)}) is counted as unmeasured activity`);
  }
  assert.equal([...buildActivity([event(-30, 0, { usage: { total_tokens: "1500" } })], { now }).slots.values()][0].totalTokens, 1500);
  assert.equal(buildActivity([event(-30, 0, { usage: { total_tokens: 0 } })], { now }).slots.size, 0);
  // Two malformed events at the same millisecond are still one event (deduplicated), a valid one beside them is separate.
  const mixed = [...buildActivity([event(-30, 0, { usage: { total_tokens: true } }), event(-30, 0, { usage: { total_tokens: true } }), event(-30, 500)], { now }).slots.values()][0];
  assert.deepEqual([mixed.events, mixed.totalTokens], [2, 500]);
}

{
  // Only fixed provider groups may be written. Group names are persisted, so nothing derived from a log, a paired
  // device or an account can ever become a key, whatever it looks like.
  for (const hostile of ["alice@example.com", "gpt-0123456789abcdef", "C:\\Users\\someone", "../../etc", "codex ", "CODEX", "x".repeat(41), "", 7, null, ["codex"], { toString: () => "codex" }]) {
    const events = buildActivity([event(-30, 100, { metadata: { sourceGroupId: hostile }, providerId: hostile })], { now });
    assert.equal(events.slots.size, 0, `rejected group ${JSON.stringify(hostile)}`);
    assert.equal(events.scans.length, 0);
    assert.equal(parseActivityRecord({ kind: "activity", group: hostile, slotStart: new Date(now).toISOString(), slotMinutes: 5, events: 1, totalTokens: 1 }), null);
    assert.equal(parseActivityRecord({ kind: "scan", group: hostile, at: new Date(now).toISOString(), eventCount: 1 }), null);
  }
  for (const group of KNOWN_GROUPS) assert.ok(parseActivityRecord({ kind: "scan", group, at: new Date(now).toISOString(), eventCount: 1 }), group);
  // A metadata group that is not a string falls back to the provider id rather than being coerced.
  assert.equal([...buildActivity([event(-30, 100, { metadata: { sourceGroupId: ["codexSpark"] }, providerId: "codex" })], { now }).slots.values()][0].group, "codex");
}

{
  // Stored records: wrong counter types, absurd magnitudes, coercible timestamps and slot sizes are rejected, not repaired.
  const base = { kind: "activity", group: "codex", slotStart: new Date(ms(-30)).toISOString(), slotMinutes: 5, events: 2, totalTokens: 10 };
  assert.ok(parseActivityRecord(base));
  for (const events of [true, [3], { a: 1 }, 1e300, -4, "x", null, undefined, Infinity]) assert.equal(parseActivityRecord({ ...base, events }), null, `events ${String(events)}`);
  for (const totalTokens of [true, [9], { a: 1 }, 1e300, -1, "x", Infinity]) assert.equal(parseActivityRecord({ ...base, totalTokens }).totalTokens, 0, `totalTokens ${String(totalTokens)} is never trusted`);
  for (const slotStart of [[new Date(ms(-30)).toISOString()], true, {}, "garbage", null]) assert.equal(parseActivityRecord({ ...base, slotStart }), null, `slotStart ${JSON.stringify(slotStart)}`);
  for (const slotMinutes of [true, "5", [5], 5.5, 0, 61, null]) assert.equal(parseActivityRecord({ ...base, slotMinutes }), null, `slotMinutes ${JSON.stringify(slotMinutes)}`);
  const scanBase = { kind: "scan", group: "codex", at: new Date(ms(-1)).toISOString(), eventCount: 3, firstEventAt: new Date(ms(-500)).toISOString() };
  assert.equal(parseActivityRecord({ ...scanBase, at: [scanBase.at] }), null);
  assert.equal(parseActivityRecord({ ...scanBase, eventCount: true }).eventCount, 0, "a boolean event count is not a count");
  assert.equal(parseActivityRecord({ ...scanBase, firstEventAt: [scanBase.firstEventAt] }).firstEventAt, null, "an array is not a timestamp");
  // Unknown fields (anything that could carry content) never survive a round trip through the parser.
  const polluted = parseActivityRecord({ ...base, model: "m", prompt: "p", path: "C:\\x", sessionId: "s", accountId: "a", token: "t", raw: { a: 1 } });
  assert.deepEqual(Object.keys(polluted).sort(), ["cachedInputTokens", "events", "group", "inputTokens", "kind", "outputTokens", "reasoningOutputTokens", "recordedAt", "slotMinutes", "slotStart", "totalTokens"]);
}

console.log("Token activity ledger: counters-only privacy, dedupe, retention, max-wins folding, incremental writes and queries passed.");
