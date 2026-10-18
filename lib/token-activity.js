"use strict";

// Privacy-minimal local token activity ledger.
//
// Purpose: let the quota-integrity analyzer ask "was there any local token
// activity between two quota observations?" over days, not just the last 24 h.
//
// What is stored (per provider group and 5-minute slot): event count and token
// totals. Nothing else. No prompts, transcripts, model names, file paths,
// session ids, account identifiers or raw provider payloads ever enter these
// records; callers pass raw usage events in and only aggregate counters come out.

const { normalizeUsage } = require("./usage-events");

const SLOT_MINUTES = 5;
const RETENTION_DAYS = 35;
const SCAN_HEARTBEAT_MS = 15 * 60 * 1000;
// Only these provider groups may enter the ledger. Group names are written to disk, so they must be
// fixed identifiers and can never carry data derived from a log, a device or an account.
const KNOWN_GROUPS = Object.freeze(["codex", "codexSpark", "openCode", "copilot", "claudeCode", "gemini", "glm", "kimi", "ollama"]);
const USAGE_FIELDS = Object.freeze([
  "input_tokens", "inputTokens", "cache_creation_input_tokens", "cacheCreationInputTokens", "cached_input_tokens",
  "cache_read_input_tokens", "cachedInputTokens", "output_tokens", "outputTokens", "reasoning_output_tokens",
  "thoughts_token_count", "reasoningOutputTokens", "total_tokens", "totalTokens"
]);

function toMs(value) {
  if (value === null || value === undefined || value === "") return null;
  // Date.parse would coerce arrays like ["2026-10-14T10:00:00Z"] into a valid date.
  if (typeof value !== "number" && typeof value !== "string") return null;
  const ms = typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function nonNegative(value) {
  // Persisted JSONL can be truncated, manually edited, or corrupted. Do not let
  // JavaScript coercion turn booleans/arrays into plausible token counts.
  if (typeof value !== "number" && typeof value !== "string") return 0;
  if (typeof value === "string" && !value.trim()) return 0;
  const number = Number(value);
  // Values beyond the safe integer range are corrupt, not large: never store them.
  return Number.isFinite(number) && number >= 0 && number <= Number.MAX_SAFE_INTEGER ? Math.round(number) : 0;
}

function validGroup(value) {
  return typeof value === "string" && KNOWN_GROUPS.includes(value) ? value : null;
}

function groupOf(event) {
  const metadataGroup = event?.metadata?.sourceGroupId;
  return validGroup(typeof metadataGroup === "string" && metadataGroup ? metadataGroup : event?.providerId);
}

/**
 * The shared usage normalizer coerces values (true -> 1, [900] -> 900, 1e300 stays). Provider logs are
 * untrusted JSON, so counters are validated here before they are aggregated. An event whose counters are
 * malformed still counts as activity (something happened at that time) but contributes no tokens, which
 * can only make a "no local activity" verdict harder to reach, never easier.
 */
function strictUsage(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, usage: null };
  const clean = {};
  for (const field of USAGE_FIELDS) {
    const value = raw[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "number" && typeof value !== "string") return { ok: false, usage: null };
    if (typeof value === "string" && !value.trim()) return { ok: false, usage: null };
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0 || number > Number.MAX_SAFE_INTEGER) return { ok: false, usage: null };
    clean[field] = number;
  }
  return { ok: true, usage: normalizeUsage(clean) };
}

function slotKey(group, slotStartMs) {
  return `${group}|${slotStartMs}`;
}

/**
 * Aggregate raw usage events into slot records and per-group scan summaries.
 * Duplicate events (same group, timestamp and total) are counted once so copies
 * of a session found through several sources do not inflate totals.
 */
function buildActivity(events, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const slotMinutes = options.slotMinutes || SLOT_MINUTES;
  const slotMs = slotMinutes * 60_000;
  const sinceMs = now - (options.retentionDays || RETENTION_DAYS) * 86_400_000;
  const slots = new Map();
  const scans = new Map();
  const seen = new Set();
  for (const event of Array.isArray(events) ? events : []) {
    const group = groupOf(event);
    const timestampMs = toMs(event?.timestampMs);
    if (!group || timestampMs === null || timestampMs > now + 5 * 60_000) continue;
    const strict = strictUsage(event.usage || {});
    const usage = strict.ok ? strict.usage : normalizeUsage({});
    if (strict.ok && !usage.totalTokens) continue;
    const scan = scans.get(group) || { group, eventCount: 0, firstEventMs: null, lastEventMs: null };
    scans.set(group, scan);
    // The scan summary describes everything the log reader can see, even outside retention.
    const dedupe = `${group}:${timestampMs}:${strict.ok ? usage.totalTokens : "unmeasured"}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    scan.eventCount += 1;
    if (scan.firstEventMs === null || timestampMs < scan.firstEventMs) scan.firstEventMs = timestampMs;
    if (scan.lastEventMs === null || timestampMs > scan.lastEventMs) scan.lastEventMs = timestampMs;
    if (timestampMs < sinceMs) continue;
    const startMs = Math.floor(timestampMs / slotMs) * slotMs;
    const key = slotKey(group, startMs);
    const slot = slots.get(key) || {
      kind: "activity", group, slotStart: new Date(startMs).toISOString(), slotMinutes,
      events: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0
    };
    slot.events += 1;
    slot.totalTokens += nonNegative(usage.totalTokens);
    slot.inputTokens += nonNegative(usage.inputTokens);
    slot.outputTokens += nonNegative(usage.outputTokens);
    slot.cachedInputTokens += nonNegative(usage.cachedInputTokens);
    slot.reasoningOutputTokens += nonNegative(usage.reasoningOutputTokens);
    slots.set(key, slot);
  }
  const iso = (ms) => (ms === null ? null : new Date(ms).toISOString());
  return {
    slots,
    scans: [...scans.values()].map((scan) => ({
      group: scan.group, eventCount: scan.eventCount, firstEventAt: iso(scan.firstEventMs), lastEventAt: iso(scan.lastEventMs)
    }))
  };
}

/** Validate and sanitize one stored record. Unknown fields are dropped. */
function parseActivityRecord(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.kind === "activity") {
    const group = validGroup(raw.group);
    const startMs = toMs(raw.slotStart);
    const slotMinutes = raw.slotMinutes;
    if (!group || startMs === null || typeof slotMinutes !== "number" || !Number.isInteger(slotMinutes) || slotMinutes < 1 || slotMinutes > 60) return null;
    const events = nonNegative(raw.events);
    if (!events) return null;
    return {
      kind: "activity", group, slotStart: new Date(startMs).toISOString(), slotMinutes, events,
      totalTokens: nonNegative(raw.totalTokens), inputTokens: nonNegative(raw.inputTokens), outputTokens: nonNegative(raw.outputTokens),
      cachedInputTokens: nonNegative(raw.cachedInputTokens), reasoningOutputTokens: nonNegative(raw.reasoningOutputTokens),
      recordedAt: toMs(raw.recordedAt) === null ? null : new Date(toMs(raw.recordedAt)).toISOString()
    };
  }
  if (raw.kind === "scan") {
    const group = validGroup(raw.group);
    const atMs = toMs(raw.at);
    if (!group || atMs === null) return null;
    const first = toMs(raw.firstEventAt), last = toMs(raw.lastEventAt);
    return {
      kind: "scan", group, at: new Date(atMs).toISOString(), eventCount: nonNegative(raw.eventCount),
      firstEventAt: first === null ? null : new Date(first).toISOString(),
      lastEventAt: last === null ? null : new Date(last).toISOString()
    };
  }
  return null;
}

/**
 * Fold appended records into one state. Slot totals only ever grow: if the
 * provider later rotates or deletes its own logs, a recomputed (smaller) slot
 * must not erase activity that was already recorded.
 */
function foldActivityRecords(rawRecords) {
  const slots = new Map();
  const scans = new Map();
  for (const raw of Array.isArray(rawRecords) ? rawRecords : []) {
    const record = parseActivityRecord(raw);
    if (!record) continue;
    if (record.kind === "activity") {
      const key = slotKey(record.group, Date.parse(record.slotStart));
      const existing = slots.get(key);
      if (!existing || record.totalTokens > existing.totalTokens || (record.totalTokens === existing.totalTokens && record.events >= existing.events)) {
        slots.set(key, record);
      }
    } else {
      const existing = scans.get(record.group);
      if (!existing) scans.set(record.group, { ...record, eventCount: record.eventCount });
      else {
        // Keep the newest scan time but never forget the earliest event ever seen.
        const merged = { ...existing };
        if (record.at >= existing.at) { merged.at = record.at; merged.lastEventAt = record.lastEventAt || existing.lastEventAt; merged.eventCount = Math.max(existing.eventCount, record.eventCount); }
        if (record.firstEventAt && (!existing.firstEventAt || record.firstEventAt < existing.firstEventAt)) merged.firstEventAt = record.firstEventAt;
        scans.set(record.group, merged);
      }
    }
  }
  return { slots: [...slots.values()].sort((a, b) => a.slotStart.localeCompare(b.slotStart)), scans: [...scans.values()] };
}

/**
 * Decide which freshly computed records need appending. Slot records are
 * written when new or larger than what is already stored. A scan heartbeat is
 * written at most every 15 minutes (or when the observed event range changes).
 * `known` is { slots: Map<key, record>, scans: Map<group, record> } and is updated in place.
 */
function planActivityWrites(activity, known, nowMs = Date.now()) {
  const recordedAt = new Date(nowMs).toISOString();
  const writes = [];
  for (const [key, slot] of activity.slots) {
    const existing = known.slots.get(key);
    if (existing && slot.totalTokens <= existing.totalTokens && slot.events <= existing.events) continue;
    const record = { ...slot, recordedAt };
    writes.push(record);
    known.slots.set(key, record);
  }
  for (const scan of activity.scans) {
    const existing = known.scans.get(scan.group);
    const age = existing ? nowMs - Date.parse(existing.at) : Infinity;
    const changed = !existing || existing.lastEventAt !== scan.lastEventAt || existing.eventCount !== scan.eventCount;
    if (!changed && age < SCAN_HEARTBEAT_MS) continue;
    const record = { kind: "scan", group: scan.group, at: recordedAt, eventCount: scan.eventCount, firstEventAt: scan.firstEventAt, lastEventAt: scan.lastEventAt };
    writes.push(record);
    known.scans.set(scan.group, record);
  }
  return writes;
}

/** Drop records older than the retention window and keep only the newest/biggest per slot. */
function compactActivityRecords(rawRecords, nowMs = Date.now(), retentionDays = RETENTION_DAYS) {
  const folded = foldActivityRecords(rawRecords);
  const sinceMs = nowMs - retentionDays * 86_400_000;
  return [...folded.slots.filter((slot) => Date.parse(slot.slotStart) >= sinceMs), ...folded.scans];
}

/** Index folded slots by group (sorted by time) for repeated window queries. */
function indexActivity(folded) {
  const byGroup = new Map();
  for (const slot of folded?.slots || []) {
    if (!byGroup.has(slot.group)) byGroup.set(slot.group, []);
    byGroup.get(slot.group).push({
      startMs: Date.parse(slot.slotStart), endMs: Date.parse(slot.slotStart) + slot.slotMinutes * 60_000,
      events: slot.events, totalTokens: slot.totalTokens, inputTokens: slot.inputTokens, outputTokens: slot.outputTokens
    });
  }
  for (const rows of byGroup.values()) rows.sort((a, b) => a.startMs - b.startMs);
  const scans = new Map((folded?.scans || []).map((scan) => [scan.group, scan]));
  return { byGroup, scans };
}

/** Measured totals for slots overlapping [fromMs, toMs]. Resolution is one slot. */
function summarizeWindow(index, groups, fromMs, toMs) {
  const result = { events: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, slotCount: 0, byGroup: {} };
  for (const group of groups) {
    const rows = index.byGroup.get(group) || [];
    const entry = { events: 0, totalTokens: 0 };
    for (const row of rows) {
      if (row.endMs <= fromMs) continue;
      if (row.startMs > toMs) break;
      entry.events += row.events;
      entry.totalTokens += row.totalTokens;
      result.inputTokens += row.inputTokens;
      result.outputTokens += row.outputTokens;
      result.slotCount += 1;
    }
    result.events += entry.events;
    result.totalTokens += entry.totalTokens;
    result.byGroup[group] = entry;
  }
  return result;
}

module.exports = {
  SLOT_MINUTES, RETENTION_DAYS, SCAN_HEARTBEAT_MS, KNOWN_GROUPS,
  buildActivity, parseActivityRecord, foldActivityRecords, planActivityWrites, compactActivityRecords, indexActivity, summarizeWindow
};
