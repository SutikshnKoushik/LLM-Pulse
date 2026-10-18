"use strict";

const crypto = require("node:crypto");
const WEEK_MINUTES = 10080;
const JITTER_MS = 90 * 1000;
const iso = (value) => {
  if (value === null || value === undefined) return null;
  const ms = typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};
const percent = (value) => value !== null && value !== undefined && Number.isFinite(Number(value))
  ? Math.max(0, Math.min(100, Number(value))) : null;
const opaqueKey = (value) => value ? crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 24) : null;

function weeklyWindow(snapshot) {
  for (const slot of ["primary", "secondary"]) {
    const w = snapshot?.[slot];
    if (Number(w?.windowDurationMins ?? w?.window_minutes) !== WEEK_MINUTES) continue;
    const usedPercent = percent(w.usedPercent ?? w.used_percent);
    const resetsAt = iso(w.resetsAt ?? w.resets_at);
    if (usedPercent !== null && resetsAt) return { usedPercent, resetsAt, windowMinutes: WEEK_MINUTES };
  }
  return null;
}

// Counters in a provider response are untrusted: only real numbers (or numeric strings) are accepted, so
// `true`, `[5]` or `{}` can never turn into a plausible 1-minute window or a 1 % usage figure.
function strictNumber(value) {
  if (typeof value === "string") { if (!value.trim()) return null; }
  else if (typeof value !== "number") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// Every window the response describes that is complete and bounded (up to one year), in response order.
function quotaWindows(snapshot) {
  const windows = [];
  for (const slot of ["primary", "secondary"]) {
    const w = snapshot?.[slot];
    if (!w || typeof w !== "object" || Array.isArray(w)) continue;
    const duration = strictNumber(w.windowDurationMins ?? w.window_minutes ?? w.windowMinutes);
    const used = strictNumber(w.usedPercent ?? w.used_percent);
    const resetsAt = iso(w.resetsAt ?? w.resets_at);
    if (duration === null || used === null || !resetsAt) continue;
    const windowMinutes = Math.round(duration);
    if (windowMinutes < 1 || windowMinutes > 525600) continue;
    windows.push({ usedPercent: percent(used), resetsAt, windowMinutes });
  }
  return windows;
}

// One window is recorded per snapshot. The weekly window is preferred (it is what the reset-history view is built
// on). Otherwise the LONGEST window wins, so the choice never depends on whether the response happens to list a
// short window first or omits it, which would otherwise make the recorded series flip between window types.
function quotaWindow(snapshot) {
  const windows = quotaWindows(snapshot);
  return windows.find((w) => w.windowMinutes === WEEK_MINUTES)
    || windows.reduce((best, w) => (!best || w.windowMinutes > best.windowMinutes ? w : best), null);
}

// Why a response could not be recorded, as a value from a fixed vocabulary. No response content, identifiers or
// numbers ever enter it, so it is safe to persist next to a failure record.
const SNAPSHOT_FAILURE_REASONS = Object.freeze(["request_failed", "malformed_response", "no_quota_window", "no_account_id"]);
function isSparkBucket(snapshot, limitId = "") {
  return /spark|bengalfox|research/i.test(`${limitId} ${snapshot?.limitId || ""} ${snapshot?.limitName || ""}`);
}

// The app-server may key rateLimitsByLimitId by a provider-defined limit id rather than "codex".
// Match the server's live-rate-limit normalizer: prefer the explicit codex bucket, otherwise use
// the first non-Spark bucket with a valid quota window. Never treat a missing "codex" key alone
// as evidence that quota collection failed.
function quotaBucket(response) {
  const byId = response?.rateLimitsByLimitId;
  if (byId && typeof byId === "object" && !Array.isArray(byId)) {
    if (byId.codex && typeof byId.codex === "object" && quotaWindow(byId.codex)) return byId.codex;
    for (const [limitId, snapshot] of Object.entries(byId)) {
      if (snapshot && typeof snapshot === "object" && !isSparkBucket(snapshot, limitId) && quotaWindow(snapshot)) return snapshot;
    }
  }
  return response?.rateLimits && typeof response.rateLimits === "object" ? response.rateLimits : null;
}

function snapshotFailureReason(response) {
  if (!response || typeof response !== "object") return "malformed_response";
  const bucket = quotaBucket(response);
  if (!bucket || !quotaWindow(bucket)) return "no_quota_window";
  if (!response.accountId) return "no_account_id";
  return "malformed_response";
}

function normalizeSnapshot(response, capturedAt = new Date().toISOString()) {
  const bucket = quotaBucket(response);
  const window = quotaWindow(bucket);
  const at = iso(capturedAt);
  if (!at || !window || !response?.accountId) return null;
  const raw = response.rateLimitResetCredits;
  const count = raw?.availableCount;
  const availableCount = Number.isInteger(count) && count >= 0 ? count : null;
  const details = Array.isArray(raw?.credits) ? raw.credits : null;
  const credits = details?.filter((c) => c?.id).map((c) => ({
    key: opaqueKey(c.id),
    status: ["available", "redeeming", "redeemed"].includes(c.status) ? c.status : "unknown",
    grantedAt: iso(c.grantedAt),
    expiresAt: iso(c.expiresAt)
  })) ?? null;
  return {
    kind: "sample", at, accountKey: opaqueKey(response.accountId), source: "live",
    planType: typeof bucket?.planType === "string" ? bucket.planType : null,
    window,
    credits: {
      availableCount,
      complete: details !== null && availableCount !== null && credits.filter((c) => c.status === "available").length === availableCount,
      items: credits
    }
  };
}

// Only quota metadata leaves the existing log reader; paths and transcripts never enter this history.
function historicalSamples(events) {
  const samples = new Map();
  const add = (at, window, source) => {
    at = iso(at);
    if (!at || !window || !validObservation({ at, window })) return;
    const key = `${Math.round(Date.parse(window.resetsAt) / 60000)}:${window.usedPercent}`;
    const sample = { kind: "sample", at, accountKey: null, source, window };
    const pair = samples.get(key);
    if (!pair) samples.set(key, [sample, sample]);
    else {
      if (at < pair[0].at) pair[0] = sample;
      if (at > pair[1].at) pair[1] = sample;
    }
  };
  for (const e of events || []) {
    if (e.provider === "codex" && e.type === "quota_window" && Number(e.windowMinutes) === WEEK_MINUTES) {
      const p = percent(e.usedPercent), r = iso(e.resetsAt);
      if (p !== null && r) add(e.capturedAt, { usedPercent: p, resetsAt: r, windowMinutes: WEEK_MINUTES }, "quota_history");
    } else if (e.rateLimits) {
      const buckets = Array.isArray(e.rateLimits) ? e.rateLimits : [e.rateLimits];
      for (const b of buckets) {
        if (b.limit_id && b.limit_id !== "codex") continue;
        add(e.timestamp, weeklyWindow(b), "session_logs");
      }
    } else if (e.source !== "live" && e.window) {
      add(e.at, e.window, e.source === "session_logs" ? "session_logs" : "quota_history");
    }
  }
  return [...samples.values()].flatMap(([a, b]) => a.at === b.at ? [a] : [a, b]).sort((a, b) => a.at.localeCompare(b.at));
}

function validObservation(s) {
  const at = Date.parse(s.at), r = Date.parse(s.window?.resetsAt);
  return Number.isFinite(at) && Number.isFinite(r) && s.window.windowMinutes === WEEK_MINUTES &&
    percent(s.window.usedPercent) !== null && at <= r + JITTER_MS && at >= r - WEEK_MINUTES * 60000 - JITTER_MS;
}

function creditChanges(before, after) {
  if (!before || before.accountKey !== after.accountKey || !before.credits || !after.credits) return [];
  const old = before.credits, cur = after.credits;
  const previous = new Map((old.items || []).map((c) => [c.key, c]));
  const current = new Map((cur.items || []).map((c) => [c.key, c]));
  const result = [];
  const time = { from: before.at, to: after.at };
  const windowChanged = Math.abs(Date.parse(before.window.resetsAt) - Date.parse(after.window.resetsAt)) > JITTER_MS &&
    after.window.usedPercent < before.window.usedPercent;
  for (const c of cur.items || []) {
    if (!previous.has(c.key) && c.status === "available") {
      const grantedNow = c.grantedAt && c.grantedAt > before.at && c.grantedAt <= after.at;
      result.push({ type: grantedNow ? "granted" : "first_seen", ...time, expiresAt: c.expiresAt });
    }
    if (c.status === "redeemed" && ["available", "redeeming"].includes(previous.get(c.key)?.status)) result.push({ type: "redeemed", confidence: "confirmed", ...time });
  }
  if (old.complete && cur.complete) {
    for (const c of old.items || []) {
      if (!["available", "redeeming"].includes(c.status) || current.has(c.key)) continue;
      if (c.expiresAt && Date.parse(c.expiresAt) <= Date.parse(after.at)) {
        result.push({ type: "expired", confidence: "inferred", ...time });
      } else if (c.expiresAt && windowChanged && Date.parse(after.at) - Date.parse(before.at) <= 5 * 60000) {
        result.push({ type: "redeemed", confidence: "inferred", ...time });
      } else {
        result.push({ type: "missing", confidence: "unknown", ...time });
      }
    }
  } else if (old.availableCount !== null && cur.availableCount !== null && cur.availableCount < old.availableCount) {
    result.push({ type: "count_decreased", confidence: "unknown", ...time, count: old.availableCount - cur.availableCount });
  }
  return result;
}

function resetCause(before, after, resetType, interrupted = false, overlapping = false) {
  const unknown = { type: "unknown", confidence: "unknown" };
  // A changed deadline alone cannot identify who or what reset the quota.
  if (overlapping || before?.source !== "live" || after?.source !== "live" ||
      !before.accountKey || before.accountKey !== after.accountKey ||
      before.planType !== after.planType || Date.parse(after.at) <= Date.parse(before.at) ||
      Date.parse(after.at) - Date.parse(before.at) > 5 * 60000 ||
      after.window.usedPercent >= before.window.usedPercent ||
      Math.abs(Date.parse(after.window.resetsAt) - Date.parse(before.window.resetsAt)) <= JITTER_MS) return unknown;
  const changes = creditChanges(before, after);
  const redeemed = changes.find((e) => e.type === "redeemed");
  if (redeemed) return { type: "manual", confidence: redeemed.confidence };
  // A failed poll cannot erase observed credit redemption, but it prevents
  // inferring a provider/scheduled reset from an unchanged credit inventory.
  if (interrupted) return unknown;
  const old = before.credits, cur = after.credits;
  if (!old?.complete || !cur?.complete || !Array.isArray(old.items) || !Array.isArray(cur.items) ||
      changes.length || [...old.items, ...cur.items].some((c) => !["available", "redeemed"].includes(c.status))) return unknown;
  const unchanged = old.items.length === cur.items.length && old.items.every((c) =>
    cur.items.some((next) => next.key === c.key && next.status === c.status));
  if (!unchanged) return unknown;
  return { type: resetType === "early" ? "provider_inferred" : "scheduled", confidence: "inferred" };
}

function buildHistory(records, legacy = [], options = {}) {
  const now = options.now ?? Date.now();
  const samples = records.filter((s) => s.kind === "sample" && s.source === "live" && validObservation(s)).sort((a, b) => a.at.localeCompare(b.at));
  const latest = samples.at(-1) || null;
  // The history below is weekly by design, but whether the collector is RECORDING is a separate question: a live
  // sample of any bounded window (a Go plan reports one 30-day window and no weekly one) proves it is.
  const anyLive = records
    .filter((s) => s.kind === "sample" && s.source === "live" && Number.isFinite(Date.parse(s.at)) && Number.isFinite(s.window?.windowMinutes) && s.window.windowMinutes > 0)
    .sort((a, b) => a.at.localeCompare(b.at));
  const latestAny = anyLive.at(-1) || null;
  // Other live accounts are never combined. Old logs stay explicitly unscoped.
  const live = samples.filter((s) => s.accountKey === latest?.accountKey);
  const recordingStart = samples[0]?.at || null;
  const historical = historicalSamples(legacy).filter((s) => !recordingStart || s.at < recordingStart);
  const observations = [...historical, ...live].filter(validObservation).sort((a, b) => a.at.localeCompare(b.at));
  // Empty quotas can report a rolling now + seven days deadline. Only a stable
  // live zero deadline (two minutes apart) may establish a new empty window.
  const zeroGroups = new Map();
  for (const s of live.filter((s) => s.window.usedPercent === 0)) {
    const key = Math.round(Date.parse(s.window.resetsAt) / 10000);
    if (!zeroGroups.has(key)) zeroGroups.set(key, []);
    zeroGroups.get(key).push(s);
  }
  const stableZeros = [...zeroGroups.values()].filter((g) =>
    Date.parse(g.at(-1).at) - Date.parse(g[0].at) >= 120000);
  const resetTimes = [...new Set([
    ...observations.filter((s) => s.window.usedPercent > 0), ...stableZeros.flat()
  ].map((s) => Date.parse(s.window.resetsAt)))].sort((a, b) => a - b);
  const clusters = [];
  for (const r of resetTimes) {
    if (clusters.length && r - clusters.at(-1)[0] <= JITTER_MS) clusters.at(-1).push(r);
    else clusters.push([r]);
  }
  const lookup = new Map(clusters.flatMap((c, i) => c.map((r) => [r, i])));
  const grouped = clusters.map(() => []);
  for (const s of observations) {
    const index = lookup.get(Date.parse(s.window.resetsAt));
    if (index !== undefined) grouped[index].push(s);
    else {
      const matching = clusters.findIndex((c) => Math.abs(c[0] - Date.parse(s.window.resetsAt)) <= JITTER_MS);
      if (matching >= 0) grouped[matching].push(s);
    }
  }
  const windows = grouped.filter((g) => g.length).map((g) => {
    const r = Math.min(...g.map((s) => Date.parse(s.window.resetsAt)));
    const positive = g.some((s) => s.window.usedPercent > 0);
    const fresh = g.filter((s) => s.source === "live");
    if (!positive && fresh.length < 2) return null; // zero-use moving deadlines are not extra cycles
    return {
      startsAt: new Date(r - WEEK_MINUTES * 60000).toISOString(),
      scheduledResetAt: new Date(r).toISOString(),
      firstObservedAt: g[0].at, lastObservedAt: g.at(-1).at,
      maxUsedPercent: Math.max(...g.map((s) => s.window.usedPercent)),
      accountScope: g.some((s) => s.source !== "live") ? "historical_unscoped" : "current_account",
      source: fresh.length ? "live" : "historical",
      startEstimated: true,
      samples: g
    };
  }).filter(Boolean).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const creditEvents = [];
  for (let i = 1; i < live.length; i++) creditEvents.push(...creditChanges(live[i - 1], live[i]));
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i], next = windows[i + 1];
    w.closedAt = null;
    w.resetType = Date.parse(w.scheduledResetAt) < now ? "unobserved" : "active";
    w.confidence = w.source === "live" ? "observed" : "inferred";
    w.durationDays = null;
    w.overlap = false;
    w.gap = false;
    w.resetCause = { type: "unknown", confidence: "unknown" };
    if (next) {
      w.closedAt = next.startsAt < w.scheduledResetAt ? next.startsAt : w.scheduledResetAt;
      w.durationDays = (Date.parse(w.closedAt) - Date.parse(w.startsAt)) / 86400000;
      w.resetType = Date.parse(w.closedAt) < Date.parse(w.scheduledResetAt) - JITTER_MS ? "early" : "regular";
      w.overlap = Date.parse(w.lastObservedAt) > Date.parse(next.firstObservedAt) + 5 * 60000;
      const before = w.samples.filter((s) => s.at <= next.firstObservedAt).at(-1);
      w.resetObservedBetween = { from: before?.at || w.firstObservedAt, to: next.firstObservedAt };
      w.gap = !before || Date.parse(next.firstObservedAt) - Date.parse(before.at) > 24 * 3600000;
      const interrupted = records.some((s) => s.kind === "gap" && s.at > before?.at && s.at < next.firstObservedAt);
      w.resetCause = resetCause(before, next.samples[0], w.resetType, interrupted, w.overlap);
      w.creditRedemption = w.resetCause.type === "manual" ? w.resetCause.confidence : null;
      if (w.creditRedemption === "confirmed") w.confidence = "confirmed";
      else if (w.overlap || w.gap) w.confidence = "uncertain";
    }
    delete w.samples;
  }
  const completed = windows.filter((w) => w.closedAt);
  const limit = [10, 30, 0].includes(Number(options.limit)) ? Number(options.limit) : 10;
  const selected = limit ? completed.slice(-limit) : completed;
  const reliable = selected.filter((w) => !w.overlap && !w.gap && w.durationDays > 0 && w.durationDays <= 8);
  const mean = (items, key) => items.length ? items.reduce((sum, w) => sum + w[key], 0) / items.length : null;
  const orderedRecords = records.slice().sort((a, b) => a.at.localeCompare(b.at));
  const gaps = orderedRecords.filter((s, i) => s.kind === "gap" && orderedRecords[i - 1]?.kind !== "gap");
  const silentGaps = live.filter((s, i) => i > 0 && Date.parse(s.at) - Date.parse(live[i - 1].at) > 5 * 60000 &&
    !gaps.some((g) => g.at > live[i - 1].at && g.at < s.at));
  const lastGap = orderedRecords.findLast((s) => s.kind === "gap");
  return {
    generatedAt: new Date(now).toISOString(),
    current: windows.findLast((w) => w.resetType === "active") || null,
    credits: latest?.credits || null,
    lastLiveAt: latestAny?.at || null,
    recordingStartedAt: live[0]?.at || anyLive[0]?.at || null,
    liveStatus: !latestAny || (lastGap && lastGap.at > latestAny.at) ? "unavailable" : now - Date.parse(latestAny.at) > 6 * 60000 ? "stale" : "live",
    summary: {
      totalWindows: completed.length, selectedWindows: selected.length,
      earlyResets: reliable.filter((w) => w.resetType === "early").length,
      uncertainWindows: selected.filter((w) => w.confidence === "uncertain").length,
      averageDurationDays: mean(reliable, "durationDays"), durationSampleCount: reliable.length,
      averageMaxUsedPercent: mean(selected, "maxUsedPercent"), expectedDurationDays: 7,
      manualResets: selected.filter((w) => w.resetCause.type === "manual").length,
      providerResetsInferred: selected.filter((w) => w.resetCause.type === "provider_inferred").length,
      scheduledResets: selected.filter((w) => w.resetCause.type === "scheduled").length,
      unknownResetCauses: selected.filter((w) => w.resetCause.type === "unknown").length,
      confirmedRedemptions: creditEvents.filter((e) => e.type === "redeemed" && e.confidence === "confirmed").length,
      inferredRedemptions: creditEvents.filter((e) => e.type === "redeemed" && e.confidence === "inferred").length,
      recordingGaps: gaps.length + silentGaps.length,
      historicalUnscoped: selected.some((w) => w.accountScope === "historical_unscoped")
    },
    windows: selected.slice().reverse(), creditEvents: creditEvents.slice(-30).reverse(),
    lastGapAt: gaps.at(-1)?.at || null
  };
}

module.exports = { normalizeSnapshot, historicalSamples, buildHistory, creditChanges, resetCause, snapshotFailureReason, SNAPSHOT_FAILURE_REASONS };
