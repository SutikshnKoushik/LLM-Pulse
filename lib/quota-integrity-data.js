"use strict";

// Streaming reader shared by the CLI report and the /api/quota-integrity route.
//
// Reads only the dashboard's own quota metadata files. It never opens prompt text,
// transcripts, provider credentials or token files, and only keeps the rows the analyzer
// needs. Line endings may be LF or CRLF and a leading UTF-8 BOM is tolerated, because
// files that were opened or re-saved with Windows tools often gain both.

const fs = require("node:fs");
const os = require("node:os");
const readline = require("node:readline");
const path = require("node:path");
const { parseActivityRecord } = require("./token-activity");

const FILES = Object.freeze({
  quotaEvents: "quota-events.jsonl",
  snapshots: "codex-reset-snapshots.jsonl",
  activity: "token-activity.jsonl"
});

// A plateau (and therefore the activity interval of a quota step) can start up to one quota window before the
// requested range, and windows can be 30 days (monthly plans) or more, so activity is loaded as far back as the
// ledger keeps it (35 days) plus a day, whatever the quota range.
const ACTIVITY_LOOKBACK_MS = 36 * 86_400_000;

function toMs(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean" || typeof value === "object") return null;
  const ms = typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

async function streamJsonl(filePath, onRow, stats) {
  let stream;
  try {
    stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let first = true;
    for await (let line of lines) {
      if (first) { line = line.replace(/^\uFEFF/, ""); first = false; }
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { stats.malformedLines += 1; continue; }
      if (row && typeof row === "object") onRow(row);
      else stats.malformedLines += 1;
    }
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  } finally {
    stream?.destroy();
  }
}

/**
 * @param {{ dataDir: string, sinceMs?: number|null, extraSnapshots?: object[] }} options
 * @returns inputs for analyzeQuotaIntegrity plus read statistics (counts only, no content).
 */
async function readQuotaIntegrityInputs({ dataDir, sinceMs = null, extraSnapshots = [] }) {
  const stats = { malformedLines: 0, unplacedRows: 0, filesFound: { quotaEvents: false, snapshots: false, activity: false } };
  const bounded = Number.isFinite(sinceMs);

  // Quota ledger: keep in-range quota windows plus the newest earlier row per window as a baseline.
  const quotaEvents = [];
  const eventBaseline = new Map();
  stats.filesFound.quotaEvents = await streamJsonl(path.join(dataDir, FILES.quotaEvents), (row) => {
    if (row.type !== "quota_window") return;
    const ms = toMs(row.capturedAt);
    if (ms === null) {
      // Cannot be placed in a time range; with a bounded range it is skipped, otherwise the
      // analyzer counts it as an ignored malformed event.
      if (bounded) stats.unplacedRows += 1; else quotaEvents.push(row);
      return;
    }
    if (!bounded || ms >= sinceMs) { quotaEvents.push(row); return; }
    const key = `${row.provider}:${row.windowKey}`;
    const held = eventBaseline.get(key);
    if (!held || ms >= held.ms) eventBaseline.set(key, { ms, row });
  }, stats);
  for (const { row } of eventBaseline.values()) quotaEvents.push(row);

  // Codex live snapshots: samples per account get the same baseline treatment; failure rows only in range.
  const codexSnapshots = [];
  const sampleBaseline = new Map();
  const addSnapshot = (row) => {
    if (row.kind === "gap") {
      const ms = toMs(row.at);
      if (ms !== null && (!bounded || ms >= sinceMs)) codexSnapshots.push(row);
      return;
    }
    if (row.kind !== "sample") return;
    const ms = toMs(row.at);
    if (ms === null) { stats.unplacedRows += 1; return; }
    if (!bounded || ms >= sinceMs) { codexSnapshots.push(row); return; }
    const key = typeof row.accountKey === "string" ? row.accountKey : "";
    const held = sampleBaseline.get(key);
    if (!held || ms >= held.ms) sampleBaseline.set(key, { ms, row });
  };
  stats.filesFound.snapshots = await streamJsonl(path.join(dataDir, FILES.snapshots), addSnapshot, stats);
  for (const row of extraSnapshots) if (row && typeof row === "object") addSnapshot(row);
  for (const { row } of sampleBaseline.values()) codexSnapshots.push(row);

  // Token activity ledger: counters only. Scan heartbeats are always kept, slots from further back.
  const activityRecords = [];
  const activitySince = bounded ? sinceMs - ACTIVITY_LOOKBACK_MS : null;
  stats.filesFound.activity = await streamJsonl(path.join(dataDir, FILES.activity), (row) => {
    const record = parseActivityRecord(row);
    if (!record) return;
    if (record.kind === "activity" && activitySince !== null && Date.parse(record.slotStart) < activitySince) return;
    activityRecords.push(record);
  }, stats);

  stats.activityLoadedFromMs = activitySince;
  return { quotaEvents, codexSnapshots, activityRecords, stats };
}

// ---------------------------------------------------------------- which data directory?
//
// The report must read the folder the dashboard is actually writing to. This mirrors server.js exactly:
//   DATA_DIR = expandHome(LLM_USAGE_DATA_DIR || DATA_DIR || <project>/data)
// where expandHome only expands "~" and "~/" (not "~\"), so a path the server would treat literally is never
// silently "corrected" here. The installed Electron app always sets LLM_USAGE_DATA_DIR itself (to
// %APPDATA%\LLM Usage Dashboard\data) unless it was already set, so DATA_DIR has no effect there. A canary test
// compares these rules with server.js and electron/main.js so they cannot drift apart unnoticed.
function expandHome(value) {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

const DATA_DIR_SOURCES = Object.freeze({
  argument: "--data-dir argument",
  LLM_USAGE_DATA_DIR: "LLM_USAGE_DATA_DIR environment variable",
  DATA_DIR: "DATA_DIR environment variable (the installed app ignores this one)",
  project_default: "project default (the data folder next to server.js; source mode only)"
});

function resolveDataDir({ argument = null, env = process.env, root, cwd = process.cwd() }) {
  let source = "project_default";
  let raw = path.join(root, "data");
  if (argument) { source = "argument"; raw = argument; }
  else if (env.LLM_USAGE_DATA_DIR) { source = "LLM_USAGE_DATA_DIR"; raw = env.LLM_USAGE_DATA_DIR; }
  else if (env.DATA_DIR) { source = "DATA_DIR"; raw = env.DATA_DIR; }
  return { dir: path.resolve(cwd, expandHome(raw)), source };
}

function installedAppDataDir({ env = process.env, platform = process.platform } = {}) {
  return platform === "win32" && env.APPDATA ? path.join(env.APPDATA, "LLM Usage Dashboard", "data") : null;
}

async function newestObservationMs(dir) {
  let newest = null;
  for (const name of [FILES.snapshots, FILES.quotaEvents]) {
    try {
      const { mtimeMs } = await fs.promises.stat(path.join(dir, name));
      if (newest === null || mtimeMs > newest) newest = mtimeMs;
    } catch { /* missing file */ }
  }
  return newest;
}

/**
 * Safety net for the most damaging mistake: reporting from a folder the app is not using. When the folder was
 * not chosen explicitly (default, or DATA_DIR which the installed app ignores) on Windows, and the installed
 * app's folder holds newer observations, say so. Returns null when there is nothing to warn about.
 */
async function competingDataDir({ chosen, source, env = process.env, platform = process.platform }) {
  if (source === "argument" || source === "LLM_USAGE_DATA_DIR") return null;
  const installed = installedAppDataDir({ env, platform });
  if (!installed || path.resolve(installed).toLowerCase() === path.resolve(chosen).toLowerCase()) return null;
  const installedNewest = await newestObservationMs(installed);
  if (installedNewest === null) return null;
  const chosenNewest = await newestObservationMs(chosen);
  return chosenNewest === null || installedNewest > chosenNewest ? { installed } : null;
}

module.exports = { FILES, ACTIVITY_LOOKBACK_MS, DATA_DIR_SOURCES, expandHome, resolveDataDir, installedAppDataDir, competingDataDir, readQuotaIntegrityInputs, streamJsonl };
