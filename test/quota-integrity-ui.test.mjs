import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { analyzeQuotaIntegrity } = require("../lib/quota-integrity.js");
const read = (relative) => readFile(new URL(relative, import.meta.url), "utf8");

// ---------------------------------------------------------------- locale files
const localeNames = (await readdir(new URL("../public/i18n/", import.meta.url))).filter((name) => name.endsWith(".json")).sort();
assert.equal(localeNames.length, 27, "all 27 locale files are present");
const locales = {};
for (const name of localeNames) locales[name.replace(".json", "")] = JSON.parse(await read(`../public/i18n/${name}`));
const flatten = (object, prefix = "") => Object.entries(object).flatMap(([key, value]) => (value && typeof value === "object" ? flatten(value, `${prefix}${key}.`) : [[`${prefix}${key}`, value]]));
const english = Object.fromEntries(flatten(locales.en.quotaIntegrity));
const placeholders = (text) => (String(text).match(/\{\w+\}/g) || []).sort().join(",");
for (const [code, data] of Object.entries(locales)) {
  assert.ok(data.quotaIntegrity, `${code}: quotaIntegrity namespace present`);
  const translated = Object.fromEntries(flatten(data.quotaIntegrity));
  assert.deepEqual(Object.keys(translated).sort(), Object.keys(english).sort(), `${code}: same keys as English`);
  for (const key of Object.keys(english)) {
    assert.ok(typeof translated[key] === "string" && translated[key].trim(), `${code}.${key}: not empty`);
    assert.equal(placeholders(translated[key]), placeholders(english[key]), `${code}.${key}: same placeholders`);
  }
  if (code !== "en") {
    const untranslated = Object.keys(english).filter((key) => translated[key] === english[key]).length;
    assert.ok(untranslated <= 12, `${code}: ${untranslated} strings are still identical to English`);
  }
}

// ---------------------------------------------------------------- every key the code can ask for exists
const appSource = await read("../public/app.js");
const analyzerSource = await read("../lib/quota-integrity.js");
const html = await read("../public/index.html");
const panelSource = appSource.slice(appSource.indexOf("function renderQuotaIntegrityContent"), appSource.indexOf("function renderGptAccounts"));
assert.ok(panelSource.length > 2000, "panel source located");
for (const match of panelSource.matchAll(/\btext\(\s*"([\w.]+)"/g)) assert.ok(english[match[1]], `missing key ${match[1]}`);
for (const match of panelSource.matchAll(/\bfact\(\s*"([\w.]+)"/g)) assert.ok(english[`fact.${match[1]}`], `missing key fact.${match[1]}`);
for (const match of panelSource.matchAll(/\bfact\(\s*[^"]*?\?\s*"(\w+)"\s*:\s*"(\w+)"/g)) { assert.ok(english[`fact.${match[1]}`]); assert.ok(english[`fact.${match[2]}`]); }
for (const match of panelSource.matchAll(/quotaIntegrity\.fact\.\$\{[^}]*"(\w+)"\s*:\s*"(\w+)"/g)) { assert.ok(english[`fact.${match[1]}`]); assert.ok(english[`fact.${match[2]}`]); }
for (const match of html.matchAll(/data-i18n(?:-aria-label)?="quotaIntegrity\.([\w.]+)"/g)) assert.ok(english[match[1]], `index.html references missing key ${match[1]}`);
const anomalyTypes = [...analyzerSource.matchAll(/\btype: (?:silent \? )?"([a-z_]+)"(?: : "([a-z_]+)")?/g)].flatMap((m) => [m[1], m[2]]).filter((type) => type && type !== "usage_step");
assert.deepEqual([...new Set(anomalyTypes)].sort(), Object.keys(english).filter((key) => key.startsWith("types.")).map((key) => key.slice(6)).sort(), "every finding type has exactly one title and vice versa");
assert.ok(anomalyTypes.length >= 8);
for (const type of new Set(anomalyTypes)) assert.ok(english[`types.${type}`], `no title for finding type ${type}`);
const hypothesisSources = [
  analyzerSource.slice(analyzerSource.indexOf("const BASE_HYPOTHESES"), analyzerSource.indexOf("]);", analyzerSource.indexOf("const BASE_HYPOTHESES"))),
  ...[...analyzerSource.matchAll(/hypotheses\.push\(([^)]*)\)/g)].map((m) => m[1]),
  ...[...analyzerSource.matchAll(/entry\.hypotheses = \[([^\]]*)\]/g)].map((m) => m[1])
];
const hypothesisCodes = new Set(hypothesisSources.flatMap((chunk) => [...chunk.matchAll(/"([a-z_]+)"/g)].map((m) => m[1])));
assert.ok(hypothesisCodes.size >= 7);
for (const code of hypothesisCodes) assert.ok(english[`hypotheses.${code}`], `no text for hypothesis ${code}`);
for (const key of ["status.attention", "status.no_anomaly_detected", "status.insufficient_data", "stepStatus.activity_present", "stepStatus.shared_source_activity", "stepStatus.no_local_activity", "stepStatus.not_assessable",
  "reason.history_start", "reason.no_local_history", "reason.before_local_history", "reason.ingest_pending", "gapKind.collector_unavailable", "gapKind.no_observations",
  "confidenceWord.confirmed", "confidenceWord.inferred", "confidenceWord.possible", "level.medium", "level.low"]) assert.ok(english[key], key);
assert.ok(appSource.includes('"quota-integrity"'), "panel is registered in the dashboard section order");

// ---------------------------------------------------------------- a rich report from the real analyzer
const now = Date.parse("2026-10-14T10:00:00.000Z");
const at = (minutes) => new Date(now + minutes * 60_000).toISOString();
const reset = at(5 * 24 * 60);
const sample = (minutes, used, resetsAt = reset, accountKey = "hashed-secret-a", extra = {}) => ({ kind: "sample", source: "live", at: at(minutes), accountKey, window: { usedPercent: used, resetsAt, windowMinutes: 10080 }, ...extra });
const snapshots = [];
for (let step = 0; step < 10; step++) { for (let m = -4000 + step * 150; m < -4000 + step * 150 + 140; m++) snapshots.push(sample(m, 20 + step * 2)); }
for (let m = -2500; m <= -1400; m++) snapshots.push(sample(m, 40));
snapshots.push({ kind: "gap", at: at(-1390) }, { kind: "gap", at: at(-1384.9) }, sample(-1300, 40));
for (let m = -1299; m <= -201; m += 1) snapshots.push(sample(m, 40));
snapshots.push(sample(-200, 42)); // step with no local activity
snapshots.push(sample(-100, 5, at(2 * 24 * 60), "hashed-secret-b"), sample(-99, 5, at(2 * 24 * 60), "hashed-secret-b"));
snapshots.push({ ...sample(-30, 60, at(1 * 24 * 60), "hashed-secret-b"), credits: { availableCount: 1, complete: true, items: [{ key: "credit-key-secret", status: "available", expiresAt: at(1000) }] } });
snapshots.push({ ...sample(-29, 1, reset, "hashed-secret-b"), credits: { availableCount: 0, complete: true, items: [{ key: "credit-key-secret", status: "redeemed" }] } });
const activityRecords = [{ kind: "scan", group: "codex", at: at(-1), eventCount: 99, firstEventAt: at(-9000), lastEventAt: at(-1500) }];
for (let step = 0; step < 10; step++) activityRecords.push({ kind: "activity", group: "codex", slotStart: at(-4000 + step * 150 + 60), slotMinutes: 5, events: 3, totalTokens: 90_000 + step * 1000, recordedAt: at(-1) });
const quotaEvents = [
  { type: "quota_window", provider: "claudeCode", windowKey: "five_hour", capturedAt: at(-300), usedPercent: 70, resetsAt: at(60), windowMinutes: 300 },
  { type: "quota_window", provider: "claudeCode", windowKey: "five_hour", capturedAt: at(-200), usedPercent: 40, resetsAt: at(60), windowMinutes: 300 }
];
const report = analyzeQuotaIntegrity({ now, quotaEvents, codexSnapshots: snapshots, activityRecords });
const seen = new Set(report.anomalies.map((entry) => entry.type));
for (const type of ["usage_increase_without_local_activity", "collector_gap", "observation_gap", "account_changed", "reset_deadline_changed_early", "usage_rolled_back"]) assert.ok(seen.has(type), `scenario produced ${type}`);
assert.ok(report.estimates.tokensPerPercentPoint, "scenario produced an estimate");
assert.ok(report.gaps.length >= 2 && report.history.windows.length >= 1 && report.steps.length >= 10);

// ---------------------------------------------------------------- render in every locale
const app = (await read("../public/app.js")).replace("\ninit();", "\n// bootstrap disabled");
const makeContext = () => ({ document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] }, window: {}, navigator: {}, localStorage: { getItem: () => null }, Intl, Date, console, URLSearchParams, setTimeout, clearTimeout });
const render = (translations, value) => vm.runInNewContext(`${app}\nstate.translations = ${JSON.stringify(translations)}; state.fallbackTranslations = {}; renderQuotaIntegrityContent(${JSON.stringify(value)});`, makeContext());

for (const [code, data] of Object.entries(locales)) {
  const output = render(data, report);
  assert.ok(!/quotaIntegrity\.[a-z]/i.test(output.replaceAll("quotaIntegrity.title", "")), `${code}: a translation key leaked into the output`);
  assert.ok(!output.includes("undefined") && !output.includes("NaN"), `${code}: undefined/NaN in output`);
  assert.ok(output.includes('role="img"') && output.includes("<svg"), `${code}: chart rendered`);
  assert.ok(output.includes("qi-finding-warning") && output.includes("qi-label-measured") && output.includes("qi-label-hypothesis") && output.includes("qi-label-estimate"), `${code}: evidence classes rendered`);
  assert.ok(!/<[a-z]+[^>]*\{[a-z]+\}/i.test(output) && !/\{\w+\}/.test(output), `${code}: unreplaced placeholder`);
  for (const secret of ["hashed-secret", "credit-key-secret", "C:\\\\"]) assert.ok(!output.includes(secret), `${code}: leaked ${secret}`);
}

// ---------------------------------------------------------------- evidence classes stay separate
{
  const output = render(locales.en, report);
  const card = output.split('<li class="qi-finding').find((chunk) => chunk.includes("Usage rose without local activity"));
  assert.ok(card, "the unattributed-usage finding renders");
  const measured = card.indexOf("qi-label-measured");
  const hypothesis = card.indexOf("qi-label-hypothesis");
  assert.ok(measured !== -1 && hypothesis > measured, "measured facts come before, and apart from, hypotheses");
  assert.ok(card.includes("Possible explanations (hypotheses, not findings)"));
  assert.ok(card.includes("Confidence: medium"));
  assert.ok(!card.includes("provider-side defect"), "English prose from the analyzer is not shown; everything is localized");
  const estimateBlock = output.split("qi-label-estimate")[1];
  assert.ok(/Confidence: low/.test(estimateBlock) && /not a conversion/.test(estimateBlock), "the estimate is labelled low confidence and not a conversion");
  assert.ok(output.includes("Evidence in the data") && output.includes("A reset credit was redeemed"), "credit evidence is shown as data evidence");
}

// ---------------------------------------------------------------- escaping, states and RTL
{
  const hostile = JSON.parse(JSON.stringify(report));
  hostile.history.windows[0].provider = "<img src=x onerror=alert(1)>";
  hostile.history.windows[0].windowKey = "\"><script>alert(2)</script>";
  const output = render(locales.en, hostile);
  assert.ok(!output.includes("<img src=x") && !output.includes("<script>alert"), "provider and window names are escaped");
  assert.ok(output.includes("&lt;img src=x"));
  assert.match(render(locales.en, null), /Loading quota integrity/);
  assert.match(vm.runInNewContext(`${app}\nstate.translations=${JSON.stringify(locales.en)}; state.quotaIntegrityError=true; renderQuotaIntegrityContent(null);`, makeContext()), /unavailable/);
  const empty = render(locales.en, analyzeQuotaIntegrity({ now }));
  assert.ok(empty.includes("Not enough data yet") && empty.includes("No live Codex data") && empty.includes("No Codex weekly changes"), "an empty report renders cleanly with the informational note");
  const quiet = render(locales.en, { ...analyzeQuotaIntegrity({ now }), anomalies: [] });
  assert.ok(quiet.includes("No findings in this range."), "a report without findings says so");
  const arabic = render(locales.ar, report);
  assert.ok(arabic.includes("سلامة") || arabic.includes("النتائج"), "Arabic renders in its own language");
}

// ---------------------------------------------------------------- a Go plan renders without calling its 30-day window weekly
{
  const goReset = at(12 * 24 * 60);
  const goRows = [];
  for (let m = 1500; m >= 1; m--) goRows.push({ kind: "sample", source: "live", at: at(-m), accountKey: "go-secret-hash", planType: "go", window: { usedPercent: 37, resetsAt: goReset, windowMinutes: 43200 } });
  const goReport = analyzeQuotaIntegrity({ now, codexSnapshots: goRows });
  assert.equal(goReport.coverage.codexLiveSamples, 1500);
  assert.equal(goReport.coverage.codexWeeklySamples, 0);
  for (const [code, data] of Object.entries(locales)) {
    const output = render(data, goReport);
    assert.ok(!/quotaIntegrity\.[a-z]/i.test(output) && !output.includes("undefined") && !output.includes("NaN"), `${code}: clean render for a monthly account`);
    assert.ok(output.includes("window_43200m (30d)"), `${code}: the window list shows the real duration`);
    assert.ok(/1\D?500/.test(output), `${code}: the observations metric counts all 1500 live snapshots`);
    assert.ok(!output.includes("<svg"), `${code}: no weekly chart is drawn for a monthly series`);
    assert.ok(!output.includes("go-secret-hash"), `${code}: no account key`);
  }
  // Older server reports have only the weekly counter: the panel falls back to it.
  const legacy = JSON.parse(JSON.stringify(goReport));
  delete legacy.coverage.codexLiveSamples;
  legacy.coverage.codexWeeklySamples = 321;
  assert.ok(/321/.test(render(locales.en, legacy)));
  // An account reporting weekly AND monthly windows draws the weekly chart from weekly data only.
  const both = [];
  for (let m = 200; m >= 1; m--) { both.push(sample(-m, m > 100 ? 80 : 83)); both.push({ ...goRows[0], at: at(-m), window: { usedPercent: 37, resetsAt: goReset, windowMinutes: 43200 } }); }
  const bothOutput = render(locales.en, analyzeQuotaIntegrity({ now, codexSnapshots: both }));
  assert.ok(bothOutput.includes("<svg") && bothOutput.includes("window_43200m (30d)") && bothOutput.includes("weekly"), "both windows are shown, the chart exists");
}

const styles = await read("../public/styles.css");
for (const selector of [".qi-banner", ".qi-finding", ".qi-block", ".qi-chart", ".qi-line", ".qi-marker-warning", ".qi-gap-band", ".qi-label-hypothesis"]) assert.ok(styles.includes(selector), `style missing for ${selector}`);
assert.ok(/\.qi-chart\s*\{[^}]*direction:\s*ltr/.test(styles), "the time axis stays left-to-right in right-to-left locales");
assert.ok(!/#[0-9a-f]{3,6}\b/i.test(styles.slice(styles.indexOf("/* Quota integrity panel"))), "panel colors come from theme variables only");

console.log("Quota integrity UI: 27 locales, key coverage, rendering, evidence separation, escaping and theming passed.");
