"use strict";

// Quota integrity analysis.
//
// Everything here is pure data in, plain JSON out. Three evidence classes are
// kept apart in the output and must stay apart in any UI:
//   measured   - values the dashboard actually recorded (percentages, times, token counts)
//   estimated  - arithmetic on measured values that depends on assumptions (e.g. tokens per point)
//   hypotheses - candidate explanations. They are never findings and never proof of a provider defect.
// Local token totals are NOT an exact conversion of subscription quota: providers weight
// models, cached input and plan multipliers differently, and local logs can be incomplete.

const { creditChanges, resetCause, SNAPSHOT_FAILURE_REASONS } = require("./codex-reset-history");
const { indexActivity, summarizeWindow, foldActivityRecords, SLOT_MINUTES, RETENTION_DAYS } = require("./token-activity");

const DEFAULTS = Object.freeze({
  usageDropPercent: 3,
  resetShiftMinutes: 10,
  earlyResetGraceMinutes: 5,
  sameWindowToleranceMinutes: 2,
  staleAfterMinutes: 6,
  minimumGapMinutes: 5,
  silentGapMinutes: 10,
  usageStepMinPercent: 1,
  unattributedWarnPercent: 2,
  activityLagMinutes: 5,
  activityLeadMinutes: 10,
  dedupeToleranceMinutes: 3,
  clockSkewMinutes: 5,
  minTokenRatioSamples: 8,
  maxAnomalies: 200,
  maxSteps: 300,
  maxHistoryPoints: 400,
  maxGaps: 100,
  maxWindows: 60
});

// Which local activity groups can plausibly draw on a provider's quota.
// primary: the provider's own local logs. shared: another local agent that may use the same
// subscription (reported separately, never merged). separate: a distinct limit bucket.
const ACTIVITY_SOURCES = Object.freeze({
  codex: Object.freeze({ primary: ["codex"], shared: ["openCode"], separate: ["codexSpark"] }),
  claudeCode: Object.freeze({ primary: ["claudeCode"], shared: [], separate: [] })
});

const BASE_HYPOTHESES = Object.freeze([
  "other_device_or_surface",
  "other_account_or_profile",
  "provider_accounting_or_adjustment",
  "local_logs_incomplete"
]);

function timestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean" || (typeof value === "object" && !(value instanceof Date))) return null;
  const ms = typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function iso(value) {
  const ms = timestamp(value);
  return ms === null ? null : new Date(ms).toISOString();
}

function finitePercent(value) {
  if (typeof value === "string") { if (!value.trim()) return null; }
  else if (typeof value !== "number") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 100 ? number : null;
}

function safeKey(value, fallback = "unknown") {
  const text = String(value ?? "").trim();
  return /^[a-zA-Z0-9_.:-]{1,80}$/.test(text) ? text : fallback;
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Number.isFinite(value) ? Math.round(value * factor) / factor : null;
}

function normalizedEvent(event) {
  if (!event || typeof event !== "object" || event.type !== "quota_window" || !event.provider || !event.windowKey) return null;
  const capturedAt = iso(event.capturedAt);
  const usedPercent = finitePercent(event.usedPercent);
  const resetsAt = iso(event.resetsAt);
  if (!capturedAt || usedPercent === null) return null;
  return {
    provider: safeKey(event.provider),
    windowKey: safeKey(event.windowKey),
    capturedAt,
    capturedMs: Date.parse(capturedAt),
    usedPercent,
    resetsAt,
    resetMs: resetsAt ? Date.parse(resetsAt) : null,
    windowMinutes: Number.isFinite(Number(event.windowMinutes)) && Number(event.windowMinutes) > 0 ? Math.round(Number(event.windowMinutes)) : null
  };
}

// Same naming as the server's quota ledger (quotaWindowKeyForWindow) so one real window has one key whichever
// source saw it: that is what lets the two sources be de-duplicated and keeps every window type in its own series.
function windowKeyForMinutes(minutes) {
  return minutes === 300 ? "five_hour" : minutes === 10080 ? "weekly" : `window_${minutes}m`;
}

// Short human label for a window key ("30d"), or null when the key carries no duration.
function windowKeyLabel(key) {
  const minutes = key === "five_hour" ? 300 : key === "weekly" ? 10080 : Number(/^window_(\d+)m$/.exec(String(key))?.[1]);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}min`;
}

function normalizedSnapshot(record) {
  if (!record || record.kind !== "sample" || record.source !== "live") return null;
  const capturedAt = iso(record.at);
  const usedPercent = finitePercent(record.window?.usedPercent);
  const resetsAt = iso(record.window?.resetsAt);
  const windowMinutes = typeof record.window?.windowMinutes === "number" ? record.window.windowMinutes : NaN;
  if (!capturedAt || usedPercent === null || !resetsAt || !Number.isInteger(windowMinutes) || windowMinutes <= 0 || windowMinutes > 525600) return null;
  const windowKey = windowKeyForMinutes(windowMinutes);
  return {
    provider: "codex",
    windowKey,
    capturedAt,
    capturedMs: Date.parse(capturedAt),
    usedPercent,
    resetsAt,
    resetMs: Date.parse(resetsAt),
    windowMinutes,
    // Already a one-way hash in the source project. Used only to avoid comparing different
    // accounts and never copied into any output.
    accountKey: typeof record.accountKey === "string" && record.accountKey ? record.accountKey : null,
    raw: record
  };
}

// ---------------------------------------------------------------- shared helpers

function isSameReset(previous, current, options) {
  return previous.resetMs !== null && current.resetMs !== null &&
    Math.abs(current.resetMs - previous.resetMs) <= options.sameWindowToleranceMinutes * 60_000;
}

function percentile(sorted, q) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position), upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

// ---------------------------------------------------------------- per-series analysis

/**
 * Walk one time-ordered series of observations for a single provider window (and, for snapshots,
 * a single account). Emits anomalies, usage "steps" (increases correlated with local activity)
 * and a compact change-point history.
 */
function analyzeSeries(points, context) {
  const { options, source, accountScoped, activity, sources } = context;
  const anomalies = [];
  const steps = [];
  const history = [];
  if (!points.length) return { anomalies, steps, history };
  const lagMs = options.activityLagMinutes * 60_000;
  let plateauIndex = 0;
  let plateauKnown = false; // the first observation's plateau began at an unknown earlier time
  history.push({ at: points[0].capturedAt, usedPercent: points[0].usedPercent, resetsAt: points[0].resetsAt, change: "start" });

  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1];
    const current = points[i];
    const sameReset = isSameReset(previous, current, options);
    const bothZero = previous.usedPercent === 0 && current.usedPercent === 0;
    // An unused window reports a rolling "now + window" deadline that only becomes fixed on
    // first use. Deadline differences before that are expected, not evidence of anything.
    const unanchored = previous.usedPercent === 0;
    const sameWindow = sameReset || unanchored;
    const delta = current.usedPercent - previous.usedPercent;
    const gap = context.gapOverlap(previous.capturedMs, current.capturedMs);
    const accountChanged = context.accountChangedBetween(previous.capturedMs, current.capturedMs);
    const base = {
      provider: current.provider,
      windowKey: current.windowKey,
      source,
      observedAt: current.capturedAt,
      previousAt: previous.capturedAt,
      previousUsedPercent: previous.usedPercent,
      usedPercent: current.usedPercent,
      previousResetsAt: previous.resetsAt || null,
      resetsAt: current.resetsAt || null,
      context: { accountScoped, overCollectionGap: gap, accountChanged }
    };
    const credit = context.creditEvidence ? context.creditEvidence(previous, current) : [];
    const redeemed = credit.find((entry) => entry.type === "redeemed");
    const explain = () => {
      if (redeemed) return { code: "reset_credit_redeemed", confidence: redeemed.confidence === "confirmed" ? "confirmed" : "inferred" };
      if (accountChanged) return { code: "account_changed", confidence: "possible" };
      return null;
    };
    const finish = (entry) => {
      const explainedBy = explain();
      if (credit.length) entry.context.credit = credit;
      if (explainedBy) { entry.explainedBy = explainedBy; entry.severity = "info"; }
      else entry.hypotheses = ["reset_credit_or_plan_change", "provider_accounting_or_adjustment", "inconsistent_source_data"];
      anomalies.push(entry);
    };

    if (sameReset && delta <= -options.usageDropPercent) {
      finish({
        type: "usage_rolled_back", severity: "warning", ...base, deltaPercent: round(delta),
        explanation: "Reported quota usage decreased while the reset deadline stayed effectively the same. This may be a provider adjustment, quota-credit event, account/context change, or inconsistent source data; it does not by itself prove a service bug."
      });
    }

    let deadlineEntry = null;
    if (previous.resetMs !== null && current.resetMs !== null && !bothZero && !unanchored) {
      const shiftMinutes = (current.resetMs - previous.resetMs) / 60_000;
      const changedEnough = Math.abs(shiftMinutes) >= options.resetShiftMinutes;
      const previousDeadlineStillAhead = current.capturedMs < previous.resetMs - options.earlyResetGraceMinutes * 60_000;
      if (changedEnough && previousDeadlineStillAhead) {
        deadlineEntry = {
          type: "reset_deadline_changed_early", severity: "warning", ...base, resetShiftMinutes: round(shiftMinutes),
          explanation: "The provider-reported reset deadline moved materially before the previously reported deadline. Capture additional observations and compare the provider's own usage view before drawing conclusions."
        };
        if (delta < 0) deadlineEntry.deltaPercent = round(delta);
        if (context.resetCause) {
          const interrupted = context.interruptedBetween(previous.capturedMs, current.capturedMs);
          const cause = context.resetCause(previous, current, interrupted);
          if (cause && cause.type !== "unknown") deadlineEntry.resetCause = cause;
        }
        finish(deadlineEntry);
      }
    }

    // ---- classify this change for the history view and the activity correlation
    const rolledOver = !sameWindow && previous.resetMs !== null && current.capturedMs >= previous.resetMs - options.earlyResetGraceMinutes * 60_000;
    const usedChanged = current.usedPercent !== previous.usedPercent;
    const windowChanged = !sameWindow && !bothZero;
    if (usedChanged || windowChanged) {
      let change = "increase";
      if (windowChanged) change = rolledOver ? "rollover" : "window_changed_early";
      else if (delta < 0) change = "decrease";
      const point = { at: current.capturedAt, usedPercent: current.usedPercent, resetsAt: current.resetsAt, change };
      if (change === "increase") point.deltaPercent = round(delta);

      if (change === "increase" && delta >= options.usageStepMinPercent && sources && !context.skipSteps) {
        const step = evaluateStep({ previous, current, delta, plateau: points[plateauIndex], plateauKnown, gap, accountChanged, base, context, lagMs });
        steps.push(step);
        point.local = { status: step.local.status, events: step.local.primaryEvents, totalTokens: step.local.primaryTokens };
        if (step.anomaly) anomalies.push(step.anomaly);
        plateauIndex = i; plateauKnown = true;
      } else if (change === "increase") {
        // Small fractional increase: keep accumulating on the same plateau.
      } else {
        plateauIndex = i; plateauKnown = true;
      }
      history.push(point);
    } else if (!sameReset && !bothZero) {
      plateauIndex = i; plateauKnown = true;
    }
  }
  return { anomalies, steps, history };
}

function evaluateStep({ previous, current, delta, plateau, plateauKnown, gap, accountChanged, base, context, lagMs }) {
  const { options, sources, activity } = context;
  // Interval start: the moment the previous value was first observed. If that plateau began before
  // the loaded data, fall back to the start of the quota window. That is a conservative bound: it
  // counts more local activity, so it can only make "no local activity" harder to conclude.
  let basis = null;
  let startMs = null;
  if (plateauKnown) { basis = "plateau"; startMs = plateau.capturedMs; }
  else if (current.resetMs !== null && current.windowMinutes) {
    basis = "window_start";
    // Never later than the previous observation, even if the reported deadline implies a later start.
    startMs = Math.min(current.resetMs - current.windowMinutes * 60_000, previous.capturedMs);
  }
  const fromMs = startMs === null ? current.capturedMs : startMs - lagMs;
  // Local token events are logged when a response finishes, which can be after the provider
  // already counted the usage, so activity shortly AFTER the observation still counts.
  const toMs = current.capturedMs + options.activityLeadMinutes * 60_000;
  const all = [...sources.primary, ...sources.shared, ...sources.separate];
  const window = summarizeWindow(activity, all, fromMs, toMs);
  const sum = (groups, key) => groups.reduce((total, group) => total + (window.byGroup[group]?.[key] || 0), 0);
  const primaryEvents = sum(sources.primary, "events");
  const primaryTokens = sum(sources.primary, "totalTokens");
  const sharedEvents = sum(sources.shared, "events");
  const sharedTokens = sum(sources.shared, "totalTokens");
  const separateEvents = sum(sources.separate, "events");

  // Presence is a positive observation and needs no coverage proof. Both ABSENCE claims
  // ("only another agent", "no local activity") do: they say the primary logs showed nothing, so they
  // are only made when every relevant log source demonstrably covered the whole interval.
  let status;
  let reason = null;
  if (primaryEvents > 0) status = "activity_present";
  else {
    const slotMs = SLOT_MINUTES * 60_000;
    // A scan only vouches for slots that had already closed when it ran. It must also lie within the
    // analysis clock, otherwise a skewed or corrupt timestamp could make old coverage look current.
    const requiredScanMs = Math.ceil(toMs / slotMs) * slotMs;
    const latestPlausibleMs = activity.nowMs + options.clockSkewMinutes * 60_000;
    const describe = (group) => {
      const scan = activity.scans.get(group) || null;
      const rows = activity.byGroup.get(group) || [];
      const firstScanMs = timestamp(scan?.firstEventAt);
      const scannedAtMs = timestamp(scan?.at);
      return {
        hasHistory: Boolean((scan && scan.eventCount > 0) || rows.length),
        firstKnownMs: Number.isFinite(firstScanMs) ? firstScanMs : (rows[0]?.startMs ?? Infinity),
        // Only a scan that actually saw events can vouch for coverage: a scan that found nothing while slot
        // records show history exists describes a reader that missed the logs.
        scannedThroughEnd: Boolean(scan && scan.eventCount > 0) && Number.isFinite(scannedAtMs) && scannedAtMs <= latestPlausibleMs && scannedAtMs >= requiredScanMs
      };
    };
    const primary = sources.primary.map(describe);
    // A shared source (another local agent that may use the same subscription) only matters if it has
    // ever produced activity here; once it has, its logs must also have been read after the interval.
    const sharedInUse = sources.shared.map(describe).filter((source) => source.hasHistory);
    let primaryReason = null;
    if (startMs === null) primaryReason = "history_start";
    else if (!primary.length || !primary.every((source) => source.hasHistory)) primaryReason = "no_local_history";
    else if (!primary.every((source) => fromMs >= source.firstKnownMs)) primaryReason = "before_local_history";
    else if (fromMs < activity.coverageFromMs) primaryReason = "before_local_history";
    else if (!primary.every((source) => source.scannedThroughEnd)) primaryReason = "ingest_pending";
    if (primaryReason) { status = "not_assessable"; reason = primaryReason; }
    else if (sharedEvents > 0) status = "shared_source_activity";
    else if (!sharedInUse.every((source) => source.scannedThroughEnd)) { status = "not_assessable"; reason = "ingest_pending"; }
    else status = "no_local_activity";
  }

  const confidence = status === "no_local_activity"
    ? (context.accountScoped && !gap && !accountChanged ? "medium" : "low")
    : null;
  const step = {
    type: "usage_step",
    provider: current.provider,
    windowKey: current.windowKey,
    source: context.source,
    observedAt: current.capturedAt,
    previousAt: previous.capturedAt,
    plateauStartAt: plateauKnown ? plateau.capturedAt : null,
    intervalBasis: basis,
    previousUsedPercent: previous.usedPercent,
    usedPercent: current.usedPercent,
    deltaPercent: round(delta),
    intervalMinutes: startMs === null ? null : round((current.capturedMs - startMs) / 60_000),
    local: {
      status, reason,
      primaryEvents, primaryTokens, sharedEvents, sharedTokens, separateEvents,
      lookbackMinutes: options.activityLagMinutes, lookaheadMinutes: options.activityLeadMinutes, resolutionMinutes: SLOT_MINUTES
    },
    confidence,
    context: { accountScoped: context.accountScoped, overCollectionGap: gap, accountChanged }
  };

  if (status === "no_local_activity") {
    const hypotheses = [...BASE_HYPOTHESES];
    if (!context.accountScoped) hypotheses.push("ledger_not_account_scoped");
    step.anomaly = {
      type: "usage_increase_without_local_activity",
      severity: confidence === "medium" && delta >= options.unattributedWarnPercent ? "warning" : "info",
      ...base,
      deltaPercent: round(delta),
      plateauStartAt: step.plateauStartAt,
      intervalBasis: step.intervalBasis,
      intervalMinutes: step.intervalMinutes,
      confidence,
      local: { primaryEvents, primaryTokens, sharedEvents, separateEvents },
      hypotheses,
      explanation: "Reported usage rose and the dashboard recorded no local token activity for this provider since the previous value was first observed. Measured values and candidate explanations are listed separately. This does not show a provider-side defect: usage on another device, surface or account, delayed accounting, or incomplete local logs would look the same."
    };
  }
  return step;
}

// ---------------------------------------------------------------- ledger events (provider-wide, change-only)

function buildLedgerSeries(events, maxMs) {
  const groups = new Map();
  let invalidEvents = 0;
  let futureDated = 0;
  let validEvents = 0;
  for (const raw of Array.isArray(events) ? events : []) {
    // The ledger also holds status and credit rows. Only malformed quota-window rows count as invalid.
    if (raw?.type !== "quota_window") continue;
    const event = normalizedEvent(raw);
    if (!event) { invalidEvents++; continue; }
    // A record dated after the analysis clock (plus a small skew allowance) cannot be a real observation.
    // Left in, it would hide staleness or fake a later "rollback", so it is excluded and counted.
    if (event.capturedMs > maxMs) { futureDated++; continue; }
    const key = `${event.provider}:${event.windowKey}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  const series = new Map();
  let oldestObservationAt = null;
  let newestObservationAt = null;
  for (const [key, group] of groups) {
    group.sort((a, b) => a.capturedMs - b.capturedMs);
    const unique = group.filter((event, index) => {
      const before = group[index - 1];
      return !(before && before.capturedMs === event.capturedMs && before.usedPercent === event.usedPercent && before.resetMs === event.resetMs);
    });
    validEvents += unique.length;
    series.set(key, unique);
    for (const event of unique) {
      if (!oldestObservationAt || event.capturedAt < oldestObservationAt) oldestObservationAt = event.capturedAt;
      if (!newestObservationAt || event.capturedAt > newestObservationAt) newestObservationAt = event.capturedAt;
    }
  }
  return { series, validEvents, invalidEvents, futureDated, oldestObservationAt, newestObservationAt };
}

// ---------------------------------------------------------------- Codex live snapshots (account scoped, ~1/min)

function buildSnapshotModel(records, options, nowMs) {
  const samples = [];
  const gaps = [];
  const maxMs = nowMs + options.clockSkewMinutes * 60_000;
  let futureDated = 0;
  for (const raw of Array.isArray(records) ? records : []) {
    if (raw?.kind === "gap") {
      const at = iso(raw.at);
      if (at && Date.parse(at) > maxMs) futureDated++;
      else if (at) gaps.push({ at, ms: Date.parse(at), reason: SNAPSHOT_FAILURE_REASONS.includes(raw.reason) ? raw.reason : null });
      continue;
    }
    const sample = normalizedSnapshot(raw);
    if (sample && sample.capturedMs > maxMs) futureDated++;
    else if (sample) samples.push(sample);
  }
  samples.sort((a, b) => a.capturedMs - b.capturedMs);
  gaps.sort((a, b) => a.ms - b.ms);

  // Account changes between consecutive live samples (hashes are compared, never emitted).
  const accountChanges = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    if (a.accountKey && b.accountKey && a.accountKey !== b.accountKey) accountChanges.push({ previousMs: a.capturedMs, ms: b.capturedMs, previousAt: a.capturedAt, at: b.capturedAt, windowKey: b.windowKey });
  }

  // Unobserved intervals. A run of consecutive failure records with no valid sample between
  // them is ONE incident (the recorder repeats a failure row about every five minutes).
  // Intervals with no records at all (dashboard closed, machine asleep) are reported separately.
  const incidents = [];
  const timeline = [
    ...samples.map((sample) => ({ ms: sample.capturedMs, sample })),
    ...gaps.map((gap) => ({ ms: gap.ms, gap }))
  ].sort((a, b) => a.ms - b.ms || (a.sample ? -1 : 1));
  let lastSample = null;
  let run = null;
  for (const entry of timeline) {
    if (entry.gap) {
      if (!run) run = { first: entry.gap, last: entry.gap };
      else run.last = entry.gap;
      continue;
    }
    const sample = entry.sample;
    if (run) {
      const startMs = lastSample ? lastSample.capturedMs : run.first.ms;
      incidents.push({
        kind: "collector_unavailable", startMs, endMs: sample.capturedMs,
        startedAt: run.first.at, lastGoodAt: lastSample?.capturedAt || null, recoveredAt: sample.capturedAt,
        durationMinutes: round((sample.capturedMs - startMs) / 60_000), failureRecords: null,
        windowKey: lastSample?.windowKey || sample.windowKey
      });
      run = null;
    } else if (lastSample && sample.capturedMs - lastSample.capturedMs > options.silentGapMinutes * 60_000) {
      incidents.push({
        kind: "no_observations", startMs: lastSample.capturedMs, endMs: sample.capturedMs,
        startedAt: lastSample.capturedAt, lastGoodAt: lastSample.capturedAt, recoveredAt: sample.capturedAt,
        durationMinutes: round((sample.capturedMs - lastSample.capturedMs) / 60_000), failureRecords: null,
        windowKey: lastSample.windowKey
      });
    }
    lastSample = sample;
  }
  let ongoing = null;
  if (run) {
    const startMs = lastSample ? lastSample.capturedMs : run.first.ms;
    ongoing = {
      kind: "collector_unavailable", startMs, endMs: nowMs, startedAt: run.first.at, lastGoodAt: lastSample?.capturedAt || null,
      recoveredAt: null, durationMinutes: round(Math.max(0, nowMs - startMs) / 60_000), failureRecords: null,
      windowKey: lastSample?.windowKey || null
    };
    incidents.push(ongoing);
  }
  // Count failure rows per incident for display (measured).
  for (const incident of incidents) {
    const inside = gaps.filter((gap) => gap.ms >= incident.startMs - 1 && gap.ms <= incident.endMs + 1);
    incident.failureRecords = inside.length;
    // Why the collector failed, counted per fixed reason code (measured; never any response content).
    incident.failureReasons = {};
    for (const gap of inside) if (gap.reason) incident.failureReasons[gap.reason] = (incident.failureReasons[gap.reason] || 0) + 1;
  }
  const reportable = incidents.filter((incident) => incident.durationMinutes >= options.minimumGapMinutes);
  return { samples, gaps, accountChanges, incidents: reportable, ongoing, lastSample, futureDated };
}

function overlapFinder(incidents) {
  return (fromMs, toMs) => {
    let best = null;
    for (const incident of incidents) {
      const overlap = Math.min(toMs, incident.endMs) - Math.max(fromMs, incident.startMs);
      if (overlap > 0 && (!best || overlap > best.overlap)) best = { overlap, kind: incident.kind, minutes: incident.durationMinutes };
    }
    return best ? { kind: best.kind, minutes: best.minutes } : null;
  };
}

function creditSummary(before, after) {
  try {
    const changes = creditChanges(before.raw, after.raw);
    const rank = { redeemed: 0, expired: 1, granted: 2, first_seen: 3, count_decreased: 4, missing: 5 };
    return changes
      .map((entry) => ({ type: String(entry.type), confidence: entry.confidence === "confirmed" || entry.confidence === "inferred" ? entry.confidence : "unknown" }))
      .sort((a, b) => (rank[a.type] ?? 9) - (rank[b.type] ?? 9) || (a.confidence === "confirmed" ? -1 : 1))
      .slice(0, 4);
  } catch { return []; }
}

// ---------------------------------------------------------------- orchestration

function dedupeAnomalies(list, options) {
  const toleranceMs = options.dedupeToleranceMinutes * 60_000;
  const kept = [];
  for (const entry of list) {
    const at = timestamp(entry.observedAt);
    const twin = at === null ? null : kept.find((other) => {
      const otherAt = timestamp(other.observedAt);
      return otherAt !== null && other.source !== entry.source && other.type === entry.type && other.provider === entry.provider && other.windowKey === entry.windowKey && Math.abs(otherAt - at) <= toleranceMs;
    });
    if (!twin) { kept.push(entry); continue; }
    // Only the same event seen through two different sources is merged; two events from one source never are.
    // Prefer the account-scoped live snapshot.
    if (twin.source !== "codex_snapshot" && entry.source === "codex_snapshot") kept[kept.indexOf(twin)] = { ...entry, alsoInLedger: true };
    else twin.alsoInSnapshots = true;
  }
  return kept;
}

function analyzeQuotaIntegrity(input = {}, userOptions = {}) {
  const options = { activitySources: ACTIVITY_SOURCES, ...DEFAULTS, ...userOptions };
  const nowMs = timestamp(input.now) ?? Date.now();
  const sinceMs = timestamp(input.sinceMs);
  const folded = input.activity || foldActivityRecords(input.activityRecords);
  const activity = indexActivity(folded);
  activity.nowMs = nowMs;
  // The ledger keeps only RETENTION_DAYS of slots, and the reader may have loaded fewer. Before either boundary the
  // absence of a slot means nothing, so no absence claim may reach back that far.
  const loadedFromMs = timestamp(input.activityLoadedFromMs);
  activity.coverageFromMs = Math.max(nowMs - RETENTION_DAYS * 86_400_000, Number.isFinite(loadedFromMs) ? loadedFromMs : -Infinity);
  const plausible = (value) => Number.isFinite(value) && value <= nowMs + options.clockSkewMinutes * 60_000;
  activity.lastIngestMs = Math.max(
    ...[...activity.scans.values()].map((scan) => timestamp(scan.at)).filter(plausible),
    ...folded.slots.map((slot) => timestamp(slot.recordedAt)).filter(plausible),
    -Infinity
  );

  const ledger = buildLedgerSeries(input.quotaEvents, nowMs + options.clockSkewMinutes * 60_000);
  const model = buildSnapshotModel(input.codexSnapshots, options, nowMs);
  const gapOverlap = overlapFinder(model.incidents);
  const accountChangedBetween = (fromMs, toMs) => model.accountChanges.some((change) => change.previousMs < toMs && change.ms > fromMs);
  const interruptedBetween = (fromMs, toMs) => model.gaps.some((gap) => gap.ms > fromMs && gap.ms < toMs);

  const anomalies = [];
  const steps = [];
  const windows = [];
  const snapshotWindowKeys = new Set(model.samples.map((sample) => sample.windowKey));

  // Ledger: one series per provider window. Provider-wide, so not account scoped.
  for (const [key, points] of ledger.series) {
    const provider = points[0].provider;
    const windowKey = points[0].windowKey;
    const sources = options.activitySources[provider] || null;
    const skipSteps = provider === "codex" && snapshotWindowKeys.has(windowKey);
    const result = analyzeSeries(points, {
      options, source: "ledger", accountScoped: false, activity, sources, skipSteps,
      gapOverlap: () => null,
      accountChangedBetween: provider === "codex" ? accountChangedBetween : () => false
    });
    anomalies.push(...result.anomalies);
    steps.push(...result.steps);
    const last = points.at(-1);
    windows.push({
      provider, windowKey, source: "ledger", observations: points.length,
      firstAt: points[0].capturedAt, lastAt: last.capturedAt, lastUsedPercent: last.usedPercent, lastResetsAt: last.resetsAt
    });
  }

  // Codex live snapshots: one series per account.
  const byAccount = new Map();
  for (const sample of model.samples) {
    const account = sample.accountKey || "unscoped";
    const key = `${account}:${sample.windowKey}`;
    if (!byAccount.has(key)) byAccount.set(key, []);
    byAccount.get(key).push(sample);
  }
  let latestAccountHistory = [];
  const latestSample = model.samples.at(-1) || null;
  // The panel chart is explicitly weekly: it follows the most recent WEEKLY series (account + window), and is empty
  // when there is none. A monthly or other window is never drawn on it, even if it is the latest sample.
  const latestWeekly = [...model.samples].reverse().find((sample) => sample.windowKey === "weekly") || null;
  const latestKey = latestWeekly ? `${latestWeekly.accountKey || "unscoped"}:weekly` : null;
  for (const [key, points] of byAccount) {
    const result = analyzeSeries(points, {
      options, source: "codex_snapshot", accountScoped: true, activity, sources: options.activitySources.codex || null, skipSteps: false,
      gapOverlap, accountChangedBetween: () => false, interruptedBetween,
      creditEvidence: (before, after) => creditSummary(before, after),
      resetCause: (before, after, interrupted) => {
        try {
          const early = after.capturedMs < before.resetMs - 90_000;
          const cause = resetCause(before.raw, after.raw, early ? "early" : "regular", interrupted, false);
          return { type: String(cause?.type || "unknown"), confidence: String(cause?.confidence || "unknown") };
        } catch { return null; }
      }
    });
    anomalies.push(...result.anomalies);
    steps.push(...result.steps);
    if (key === latestKey) latestAccountHistory = result.history;
  }

  // One row per window type seen by the live snapshots (latest sample of that type). It supersedes the change-only
  // ledger row for the same window, which is a coarser view of the same thing.
  const latestByWindow = new Map();
  for (const sample of model.samples) latestByWindow.set(sample.windowKey, sample);
  const observationsByWindow = new Map();
  for (const sample of model.samples) observationsByWindow.set(sample.windowKey, (observationsByWindow.get(sample.windowKey) || 0) + 1);
  for (const [windowKey, sample] of latestByWindow) {
    const index = windows.findIndex((entry) => entry.provider === "codex" && entry.windowKey === windowKey);
    if (index !== -1) windows.splice(index, 1);
    windows.push({
      provider: "codex", windowKey, source: "codex_snapshot", observations: observationsByWindow.get(windowKey),
      firstAt: model.samples.find((candidate) => candidate.windowKey === windowKey).capturedAt, lastAt: sample.capturedAt,
      lastUsedPercent: sample.usedPercent, lastResetsAt: sample.resetsAt
    });
  }
  for (const entry of windows) entry.windowLabel = windowKeyLabel(entry.windowKey);

  // Account changes and unobserved intervals as findings of their own.
  for (const change of model.accountChanges.slice(-20)) {
    anomalies.push({
      type: "account_changed", severity: "info", provider: "codex", windowKey: change.windowKey || "unknown", source: "codex_snapshot",
      observedAt: change.at, previousAt: change.previousAt,
      explanation: "The live Codex quota snapshot switched to a different account scope. Quota values before and after this point describe different accounts and are never compared with each other."
    });
  }
  for (const incident of model.incidents) {
    const silent = incident.kind === "no_observations";
    anomalies.push({
      type: silent ? "observation_gap" : "collector_gap",
      severity: silent ? "info" : "warning",
      provider: "codex", windowKey: incident.windowKey || latestSample?.windowKey || "unknown", source: "codex_snapshot",
      observedAt: incident.startedAt, lastGoodAt: incident.lastGoodAt, recoveredAt: incident.recoveredAt,
      durationMinutes: incident.durationMinutes, failureRecords: incident.failureRecords, failureReasons: incident.failureReasons, ongoing: incident.recoveredAt === null,
      explanation: silent
        ? "No quota observations were recorded for this interval (dashboard not running, machine asleep, or collection disabled). Quota changes during this interval were not observed."
        : "The local collector recorded consecutive unavailable observations. Quota changes during this interval may have been missed."
    });
  }

  // Freshness of the live Codex collector.
  const latest = model.lastSample;
  const lastGap = model.gaps.at(-1) || null;
  const ageMinutes = latest ? Math.max(0, (nowMs - latest.capturedMs) / 60_000) : null;
  let codexStatus = "no_data";
  if (latest) {
    if (lastGap && lastGap.ms > latest.capturedMs) codexStatus = "unavailable";
    else codexStatus = ageMinutes > options.staleAfterMinutes ? "stale" : "live";
  }
  if (!latest) {
    anomalies.push({
      type: "no_live_codex_samples", severity: "info", provider: "codex", windowKey: "unknown", source: "codex_snapshot", observedAt: null,
      explanation: "No valid live Codex quota snapshots were found in the local history. Start the dashboard with live Codex rate-limit collection enabled and verify Codex is signed in."
    });
  } else if (ageMinutes > options.staleAfterMinutes) {
    anomalies.push({
      type: "stale_codex_snapshot", severity: "warning", provider: "codex", windowKey: latest.windowKey, source: "codex_snapshot",
      observedAt: latest.capturedAt, ageMinutes: round(ageMinutes), resetsAt: latest.resetsAt, usedPercent: latest.usedPercent,
      explanation: "The last valid live Codex quota snapshot is older than the freshness threshold. Current quota cannot be inferred from this observation alone."
    });
  }

  // ---- merge, bound to the requested range, summarize
  let combined = dedupeAnomalies(anomalies, options);
  let keptSteps = steps;
  let historyPoints = latestAccountHistory;
  let incidents = model.incidents;
  if (sinceMs !== null) {
    // Observations before the range were loaded only as comparison baselines.
    const inRange = (at) => at === null || at === undefined || Date.parse(at) >= sinceMs;
    combined = combined.filter((entry) => inRange(entry.observedAt));
    keptSteps = keptSteps.filter((entry) => inRange(entry.observedAt));
    historyPoints = historyPoints.filter((point, index) => index === 0 || inRange(point.at));
    incidents = incidents.filter((incident) => inRange(incident.recoveredAt || incident.startedAt));
  }
  combined.sort((a, b) => (a.observedAt || "").localeCompare(b.observedAt || ""));
  const totalBeforeLimit = combined.length;
  const limited = combined.slice(-options.maxAnomalies);
  const countBySeverity = { warning: 0, info: 0, error: 0 };
  for (const entry of limited) countBySeverity[entry.severity] = (countBySeverity[entry.severity] || 0) + 1;

  const statusCounts = { activity_present: 0, shared_source_activity: 0, no_local_activity: 0, not_assessable: 0 };
  for (const step of keptSteps) statusCounts[step.local.status] = (statusCounts[step.local.status] || 0) + 1;
  const ratios = keptSteps
    .filter((step) => step.local.status === "activity_present" && step.local.primaryTokens > 0 && step.deltaPercent > 0 && step.provider === "codex")
    .map((step) => step.local.primaryTokens / step.deltaPercent)
    .sort((a, b) => a - b);
  const estimates = ratios.length >= options.minTokenRatioSamples
    ? { tokensPerPercentPoint: { median: Math.round(percentile(ratios, 0.5)), p25: Math.round(percentile(ratios, 0.25)), p75: Math.round(percentile(ratios, 0.75)), samples: ratios.length, confidence: "low" } }
    : { tokensPerPercentPoint: null };

  const validSamples = model.samples.length;
  const codexGroupScan = activity.scans.get("codex") || null;
  const activitySlots = folded.slots;
  const activityGroups = [...new Set([...activity.byGroup.keys(), ...activity.scans.keys()])].sort();

  return {
    schemaVersion: 2,
    generatedAt: new Date(nowMs).toISOString(),
    range: { since: sinceMs === null ? null : new Date(sinceMs).toISOString(), until: new Date(nowMs).toISOString() },
    thresholds: {
      usageDropPercent: options.usageDropPercent,
      resetShiftMinutes: options.resetShiftMinutes,
      earlyResetGraceMinutes: options.earlyResetGraceMinutes,
      staleAfterMinutes: options.staleAfterMinutes,
      minimumGapMinutes: options.minimumGapMinutes,
      silentGapMinutes: options.silentGapMinutes,
      usageStepMinPercent: options.usageStepMinPercent,
      unattributedWarnPercent: options.unattributedWarnPercent,
      activityLagMinutes: options.activityLagMinutes,
      activityLeadMinutes: options.activityLeadMinutes
    },
    coverage: {
      quotaEventsRead: Array.isArray(input.quotaEvents) ? input.quotaEvents.length : 0,
      validQuotaEvents: ledger.validEvents,
      ignoredQuotaEvents: ledger.invalidEvents,
      providerWindowCount: ledger.series.size,
      oldestQuotaObservationAt: ledger.oldestObservationAt,
      newestQuotaObservationAt: ledger.newestObservationAt,
      // codexLiveSamples counts every live snapshot whatever its window; the weekly counter counts weekly ones only.
      codexLiveSamples: validSamples,
      codexWeeklySamples: model.samples.filter((sample) => sample.windowKey === "weekly").length,
      codexWindowTypes: [...new Set(model.samples.map((sample) => sample.windowKey))].sort(),
      codexGapRecords: model.gaps.length,
      codexLastLiveSampleAt: latest?.capturedAt || null,
      codexLastSampleAgeMinutes: ageMinutes === null ? null : round(ageMinutes),
      codexAccountChanges: model.accountChanges.length,
      futureDatedRecords: ledger.futureDated + model.futureDated,
      tokenActivity: {
        slotRecords: activitySlots.length,
        slotMinutes: SLOT_MINUTES,
        groups: activityGroups,
        firstSlotAt: activitySlots[0]?.slotStart || null,
        lastSlotAt: activitySlots.at(-1)?.slotStart || null,
        lastIngestAt: Number.isFinite(activity.lastIngestMs) ? new Date(activity.lastIngestMs).toISOString() : null,
        codexLocalEventsKnown: codexGroupScan ? codexGroupScan.eventCount : null,
        codexFirstLocalEventAt: codexGroupScan?.firstEventAt || null,
        codexLastLocalEventAt: codexGroupScan?.lastEventAt || null
      },
      steps: { total: keptSteps.length, ...statusCounts }
    },
    freshness: {
      codex: { status: codexStatus, lastLiveSampleAt: latest?.capturedAt || null, ageMinutes: ageMinutes === null ? null : round(ageMinutes), lastFailureAt: lastGap?.at || null },
      staleAfterMinutes: options.staleAfterMinutes
    },
    summary: {
      total: limited.length,
      totalBeforeLimit,
      truncated: totalBeforeLimit > limited.length,
      bySeverity: countBySeverity,
      status: countBySeverity.warning ? "attention" : (validSamples || ledger.validEvents) ? "no_anomaly_detected" : "insufficient_data"
    },
    estimates,
    gaps: incidents.slice(-options.maxGaps).map(({ kind, startedAt, lastGoodAt, recoveredAt, durationMinutes, failureRecords, failureReasons, windowKey }) => ({ kind, startedAt, lastGoodAt, recoveredAt, durationMinutes, failureRecords, failureReasons: failureReasons || {}, windowKey: windowKey || null, ongoing: recoveredAt === null })),
    steps: keptSteps.slice(-options.maxSteps).map(({ anomaly, ...step }) => step),
    history: {
      codexWeekly: { points: historyPoints.slice(-options.maxHistoryPoints), truncated: historyPoints.length > options.maxHistoryPoints },
      windows: windows.sort((a, b) => b.lastAt.localeCompare(a.lastAt)).slice(0, options.maxWindows)
    },
    anomalies: limited
  };
}

module.exports = { DEFAULTS, ACTIVITY_SOURCES, analyzeQuotaIntegrity, windowKeyForMinutes, windowKeyLabel };
