// Right now, from the city's own file: how many NYC housing violations the
// owner has certified corrected inside HPD's 70-day window, what they are, how
// many homes those buildings hold, the sample building, and the last 30 days of
// FALSE / INVALID CERTIFICATION stamps.
//
//   node scripts/right-now.mjs                 -> data/right-now-<UTC today>.json
//   node scripts/right-now.mjs --today=2026-09-21
//
// Public data only (NYC Open Data). Plain Node 18+, global fetch, no
// dependencies. Apartment values are counted, never written: the file holds no
// apartment number and no owner name, and unit numbers inside the city's
// description text are redacted before anything is kept.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const V = "https://data.cityofnewyork.us/resource/wvxf-dwi5.json"; // HPD violations
const B = "https://data.cityofnewyork.us/resource/kj4p-ruqc.json"; // HPD buildings

// engine/hpd.ts: OWNER_SAYS_FIXED and CITY_SAYS_FALSE, verbatim.
const OWNER_SAYS_FIXED = ["NOV CERTIFIED ON TIME", "NOV CERTIFIED LATE"];
const CITY_SAYS_FALSE = ["FALSE CERTIFICATION", "INVALID CERTIFICATION"];
const WINDOW_DAYS = 70;

const SAMPLE_BBL = "3050840061"; // engine/hpd.ts SAMPLE_BBL: 155 Linden Boulevard, Brooklyn
const SAMPLE_FALSE_SINCE = "2026-08-01";
const SAMPLE_VIOLATION = "19178388";
const RECENT_DAYS = 30;
const BUILDING_CHUNK = 250;
const PAGE = 50000;

const VERMIN = /ROACHES|\bMICE\b|\bRATS\b/;
const MOLD = /MOLD/;
const MOLD_WORD = /\bMOLD\b/; // not in the spec; MOLD alone also matches MOLDING
const WATER_LEAK = /WATER LEAK/;

// ---- dates -----------------------------------------------------------------

const argToday = process.argv.find((a) => a.startsWith("--today="))?.slice("--today=".length);
if (argToday && !/^\d{4}-\d{2}-\d{2}$/.test(argToday)) throw new Error(`--today wants YYYY-MM-DD, got ${argToday}`);
const runAt = new Date();
const today = argToday ?? runAt.toISOString().slice(0, 10); // UTC, as convex/inbound.ts passes it to pickAsks

function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** engine/canon.ts dateOnly: "2026-08-25T00:00:00.000" -> "2026-08-25". */
const dateOnly = (s) => (typeof s === "string" ? s.slice(0, 10) : "");

/** engine/hpd.ts challengeDeadline: 70 days from certifieddate, else currentstatusdate; owner-certified rows only. */
function challengeDeadline(status, certifiedBy, statusDate) {
  if (!OWNER_SAYS_FIXED.includes(String(status ?? "").trim().toUpperCase())) return null;
  return seventyDaysFrom(certifiedBy, statusDate);
}
function seventyDaysFrom(certifiedBy, statusDate) {
  const from = certifiedBy || statusDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from ?? "")) return null;
  return addDays(from, WINDOW_DAYS);
}

// pickAsks keeps a row while challengeDeadline(row) >= today, i.e. while its
// anchor (certifieddate, else currentstatusdate) >= today - 70.
const floor = addDays(today, -WINDOW_DAYS);
const tomorrow = addDays(today, 1);

// ---- SoQL ------------------------------------------------------------------

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const inList = (xs) => `in(${xs.map(lit).join(",")})`;

const STATUS_FIXED = `currentstatus ${inList(OWNER_SAYS_FIXED)}`;
const STATUS_FALSE = `currentstatus ${inList(CITY_SAYS_FALSE)}`;
/** The window engine/hpd.ts actually applies (pickAsks via challengeDeadline). */
const W = `${STATUS_FIXED} AND ((certifieddate IS NOT NULL AND certifieddate >= ${lit(floor)}) OR (certifieddate IS NULL AND currentstatusdate >= ${lit(floor)}))`;
/** The window as first specified: currentstatusdate alone. Kept for comparison. */
const W_SPEC = `${STATUS_FIXED} AND currentstatusdate >= ${lit(floor)}`;

const queries = [];

function soqlUrl(base, params) {
  const qs = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  return `${base}?${qs}`;
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET a SoQL query. Retries once on a 5xx, a 429 or a network failure. */
async function soql(label, base, params) {
  const url = soqlUrl(base, params);
  for (let attempt = 1; ; attempt++) {
    const t0 = Date.now();
    let res = null;
    let failure = null;
    try {
      res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(120_000) });
    } catch (e) {
      failure = e;
    }
    if (res?.ok) {
      const rows = await res.json();
      if (!Array.isArray(rows)) throw new Error(`${label}: expected an array — ${url}`);
      queries.push({ label, url, status: res.status, attempts: attempt, ms: Date.now() - t0, rows: rows.length });
      return rows;
    }
    const retryable = !res || res.status >= 500 || res.status === 429;
    if (retryable && attempt < 2) {
      await pause(3000);
      continue;
    }
    const why = res ? `${res.status} ${(await res.text()).slice(0, 400)}` : String(failure?.message ?? failure);
    queries.push({ label, url, status: res?.status ?? null, attempts: attempt, ms: Date.now() - t0, error: why });
    throw new Error(`${label}: ${why}\n  ${url}`);
  }
}

const num = (v) => (v === undefined || v === null || v === "" ? null : Number(v));

// ---- privacy ---------------------------------------------------------------

/** The city's description text names the unit ("LOCATED AT APT 4B"). Redact it. */
function redactUnits(s) {
  return s
    .replace(/\bAPT\b\.?\s*(?:NO\.?|#)?\s*[A-Z0-9][A-Z0-9-]*/gi, "APT [unit]")
    .replace(/\b(APARTMENT|UNIT)\s*(?:NO\.?|#)?\s*(?=[A-Z0-9-]*\d)[A-Z0-9-]+/gi, "$1 [unit]");
}
function cleanDescription(s, n) {
  const out = redactUnits(String(s ?? "").replace(/[\u0000-\u001f]/g, "'").replace(/\s+/g, " ").trim()).slice(0, n);
  if (/\bAPT\b\.?\s*(?:NO\.?|#)?\s*(?!\[unit\])[A-Z0-9]/i.test(out)) throw new Error(`unit number survived redaction: ${out}`);
  return out;
}

// ---- 1. counts over W ------------------------------------------------------

const countSelect = "count(*) AS n, count(distinct buildingid) AS buildings, count(apartment) AS with_apartment";
const [agg] = await soql("window counts", V, { $select: countSelect, $where: W });
const [aggSpec] = await soql("window counts, currentstatusdate-only window", V, { $select: countSelect, $where: W_SPEC });
const [onlySpec] = await soql("rows in the currentstatusdate window but certified before the floor", V, {
  $select: "count(*) AS n",
  $where: `${W_SPEC} AND certifieddate IS NOT NULL AND certifieddate < ${lit(floor)}`,
});

const counts = {
  rows: num(agg.n),
  distinctBuildings: num(agg.buildings),
  withApartment: num(agg.with_apartment),
  withoutApartment: num(agg.n) - num(agg.with_apartment),
};

// ---- 2. every row in W -----------------------------------------------------

const rows = [];
for (let offset = 0; ; offset += PAGE) {
  const page = await soql(`window rows, offset ${offset}`, V, {
    $select: "violationid, buildingid, bbl, class, apartment, novdescription, currentstatus, currentstatusdate, certifieddate",
    $where: W,
    $order: "violationid",
    $limit: PAGE,
    $offset: offset,
  });
  rows.push(...page);
  if (page.length < PAGE) break;
}

const buildingIds = new Set();
const cond = { classC: 0, vermin: 0, mold: 0, moldWholeWord: 0, waterLeak: 0 };
let withApartmentRows = 0;
let outsideWindow = 0;
let anchoredAfterToday = 0;
let sampleInRows = 0;
let sampleNoApartmentInRows = 0;
for (const r of rows) {
  if (r.buildingid) buildingIds.add(String(r.buildingid));
  const hasApt = typeof r.apartment === "string" && r.apartment.trim() !== "";
  if (hasApt) withApartmentRows++;
  if (String(r.class ?? "").trim().toUpperCase() === "C") cond.classC++;
  const d = String(r.novdescription ?? "").replace(/\s+/g, " ").toUpperCase();
  if (VERMIN.test(d)) cond.vermin++;
  if (MOLD.test(d)) cond.mold++;
  if (MOLD_WORD.test(d)) cond.moldWholeWord++;
  if (WATER_LEAK.test(d)) cond.waterLeak++;
  // Self-check: every row must be one pickAsks would keep today.
  const until = challengeDeadline(r.currentstatus, dateOnly(r.certifieddate), dateOnly(r.currentstatusdate));
  if (!until || until < today) outsideWindow++;
  const anchor = dateOnly(r.certifieddate) || dateOnly(r.currentstatusdate);
  if (anchor > today) anchoredAfterToday++;
  if (String(r.bbl) === SAMPLE_BBL) {
    sampleInRows++;
    if (!hasApt) sampleNoApartmentInRows++;
  }
}

const fromRows = {
  rows: rows.length,
  distinctBuildings: buildingIds.size,
  withApartment: withApartmentRows,
  agreesWithCounts:
    rows.length === counts.rows && buildingIds.size === counts.distinctBuildings && withApartmentRows === counts.withApartment,
  rowsPickAsksWouldDrop: outsideWindow,
  rowsAnchoredAfterToday: anchoredAfterToday,
};

// ---- 3. homes in those buildings -------------------------------------------

const ids = [...buildingIds].sort((a, b) => Number(a) - Number(b));
const legal = new Map();
for (let i = 0; i < ids.length; i += BUILDING_CHUNK) {
  const chunk = ids.slice(i, i + BUILDING_CHUNK);
  const got = await soql(`buildings ${i + 1}-${i + chunk.length} of ${ids.length}`, B, {
    $select: "buildingid, legalclassa",
    $where: `buildingid ${inList(chunk)}`,
    $limit: 5000,
  });
  for (const b of got) if (!legal.has(String(b.buildingid))) legal.set(String(b.buildingid), num(b.legalclassa));
}
let apartmentsTotal = 0;
let noLegalClassA = 0;
for (const id of ids) {
  const a = legal.get(id);
  if (a === undefined) continue;
  if (a === null || !Number.isFinite(a)) noLegalClassA++;
  else apartmentsTotal += a;
}
const homes = {
  buildings: ids.length,
  buildingsFound: [...ids].filter((id) => legal.has(id)).length,
  buildingsMissing: ids.filter((id) => !legal.has(id)).length,
  buildingsWithoutLegalClassA: noLegalClassA,
  legalClassATotal: apartmentsTotal,
};

// ---- 4. the sample building ------------------------------------------------

const sampleIds = await soql("sample building ids", V, {
  $select: "buildingid, housenumber, streetname, boro, count(*) AS n",
  $where: `bbl=${lit(SAMPLE_BBL)}`,
  $group: "buildingid, housenumber, streetname, boro",
});
const sampleBuildingIds = [...new Set(sampleIds.map((r) => String(r.buildingid)).filter(Boolean))];
const sampleLegal = sampleBuildingIds.length
  ? await soql("sample building legalclassa", B, {
      $select: "buildingid, legalclassa",
      $where: `buildingid ${inList(sampleBuildingIds)}`,
    })
  : [];
const [sampleAgg] = await soql("sample building window counts", V, {
  $select: "count(*) AS n, count(apartment) AS with_apartment",
  $where: `${W} AND bbl=${lit(SAMPLE_BBL)}`,
});
const sampleFalse = await soql("sample building FALSE / INVALID since " + SAMPLE_FALSE_SINCE, V, {
  $select: "violationid, currentstatus, currentstatusdate, class, novdescription",
  $where: `bbl=${lit(SAMPLE_BBL)} AND ${STATUS_FALSE} AND currentstatusdate >= ${lit(SAMPLE_FALSE_SINCE)}`,
  $order: "currentstatusdate DESC, violationid",
  $limit: 5000,
});
const [one] = await soql(`violation ${SAMPLE_VIOLATION}`, V, {
  $select: "violationid, bbl, currentstatus, currentstatusdate, certifieddate, class",
  $where: `violationid=${lit(SAMPLE_VIOLATION)}`,
});

const sampleLegalA = sampleLegal.map((b) => ({ buildingid: String(b.buildingid), legalclassa: num(b.legalclassa) }));
const sample = {
  bbl: SAMPLE_BBL,
  address: sampleIds[0]
    ? `${sampleIds[0].housenumber} ${sampleIds[0].streetname}, ${String(sampleIds[0].boro ?? "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())}`
    : null,
  buildingIds: sampleBuildingIds,
  legalClassA: sampleLegalA,
  legalClassATotal: sampleLegalA.reduce((s, b) => s + (b.legalclassa ?? 0), 0),
  openInWindow: num(sampleAgg.n),
  openInWindowWithoutApartment: num(sampleAgg.n) - num(sampleAgg.with_apartment),
  openInWindowFromRows: sampleInRows,
  openInWindowWithoutApartmentFromRows: sampleNoApartmentInRows,
  falseOrInvalidSince: SAMPLE_FALSE_SINCE,
  falseOrInvalidCount: sampleFalse.length,
  falseOrInvalid: sampleFalse.map((r) => ({
    violationid: String(r.violationid),
    currentstatus: r.currentstatus,
    currentstatusdate: dateOnly(r.currentstatusdate),
    class: r.class ?? "",
    novdescription: cleanDescription(r.novdescription, 120),
  })),
};

const violation = one
  ? {
      violationid: String(one.violationid),
      bbl: String(one.bbl ?? ""),
      currentstatus: one.currentstatus,
      currentstatusdate: dateOnly(one.currentstatusdate),
      certifieddate: dateOnly(one.certifieddate) || null,
      class: one.class ?? "",
      // challengeDeadline's return: null unless the status is an owner certification.
      challengeDeadline: challengeDeadline(one.currentstatus, dateOnly(one.certifieddate), dateOnly(one.currentstatusdate)),
      // The bare arithmetic, whatever the status: certifieddate (else currentstatusdate) + 70 days.
      seventyDaysRunOut: seventyDaysFrom(dateOnly(one.certifieddate), dateOnly(one.currentstatusdate)),
    }
  : { violationid: SAMPLE_VIOLATION, found: false };

// ---- 5. the last 30 days of FALSE / INVALID --------------------------------

const recentFrom = addDays(today, -(RECENT_DAYS - 1));
const recent = await soql(`FALSE / INVALID by day, last ${RECENT_DAYS} days`, V, {
  $select: "date_trunc_ymd(currentstatusdate) AS day, currentstatus, count(*) AS n",
  $where: `${STATUS_FALSE} AND currentstatusdate >= ${lit(recentFrom)} AND currentstatusdate < ${lit(tomorrow)}`,
  $group: "day, currentstatus",
  $order: "day",
  $limit: 5000,
});
const byDay = new Map();
for (let d = recentFrom; d <= today; d = addDays(d, 1)) byDay.set(d, { date: d, false: 0, invalid: 0, total: 0 });
for (const r of recent) {
  const day = byDay.get(dateOnly(r.day));
  if (!day) continue;
  const n = num(r.n) ?? 0;
  if (r.currentstatus === "FALSE CERTIFICATION") day.false += n;
  else if (r.currentstatus === "INVALID CERTIFICATION") day.invalid += n;
  day.total += n;
}
const days = [...byDay.values()];
const last30 = {
  from: recentFrom,
  to: today,
  days: days.length,
  falseCertification: days.reduce((s, d) => s + d.false, 0),
  invalidCertification: days.reduce((s, d) => s + d.invalid, 0),
  total: days.reduce((s, d) => s + d.total, 0),
  byDay: days,
};

// ---- write -----------------------------------------------------------------

const out = {
  generatedAt: new Date().toISOString(),
  startedAt: runAt.toISOString(),
  today,
  sources: {
    violations: V,
    buildings: B,
    violationsPage: "https://data.cityofnewyork.us/Housing-Development/Housing-Maintenance-Code-Violations/wvxf-dwi5",
    buildingsPage: "https://data.cityofnewyork.us/Housing-Development/Buildings-Subject-to-HPD-Jurisdiction/kj4p-ruqc",
  },
  window: {
    days: WINDOW_DAYS,
    floor,
    statuses: OWNER_SAYS_FIXED,
    anchor: "certifieddate when present, else currentstatusdate (engine/hpd.ts challengeDeadline; pickAsks keeps a row while that + 70 days >= today)",
    where: W,
    upperBound: "none (neither pickAsks nor this window caps the date at today)",
    currentstatusdateOnly: {
      where: W_SPEC,
      rows: num(aggSpec.n),
      distinctBuildings: num(aggSpec.buildings),
      withApartment: num(aggSpec.with_apartment),
      rowsCertifiedBeforeFloor: num(onlySpec.n),
    },
  },
  counts,
  fromRows,
  conditions: {
    rows: rows.length,
    classC: cond.classC,
    vermin: cond.vermin,
    mold: cond.mold,
    moldWholeWord: cond.moldWholeWord,
    waterLeak: cond.waterLeak,
    patterns: {
      vermin: String(VERMIN),
      mold: String(MOLD),
      moldWholeWord: String(MOLD_WORD),
      waterLeak: String(WATER_LEAK),
      appliedTo: "novdescription, whitespace collapsed, upper-cased",
    },
  },
  homes,
  sample,
  violation,
  last30Days: last30,
  privacy: "No apartment value or owner name is stored; unit numbers in description text are redacted.",
  queries,
};

const here = dirname(fileURLToPath(import.meta.url));
const file = join(here, "..", "data", `right-now-${today}.json`);
await mkdir(dirname(file), { recursive: true });
await writeFile(file, `${JSON.stringify(out, null, 2)}\n`);

const fmt = (n) => (n === null || n === undefined ? "?" : Number(n).toLocaleString("en-US"));
console.log(`Right now, ${today} (window from ${floor}, anchored on certifieddate else currentstatusdate)`);
console.log(`  certified-corrected, inside HPD's 70 days: ${fmt(counts.rows)} violations in ${fmt(counts.distinctBuildings)} buildings`);
console.log(`    with an apartment ${fmt(counts.withApartment)}, without ${fmt(counts.withoutApartment)}; rows agree: ${fromRows.agreesWithCounts}; anchored after today: ${fromRows.rowsAnchoredAfterToday}`);
console.log(`    currentstatusdate-only window: ${fmt(aggSpec.n)} (${fmt(onlySpec.n)} certified before ${floor})`);
console.log(`  class C ${fmt(cond.classC)} · vermin ${fmt(cond.vermin)} · mold ${fmt(cond.mold)} (whole word ${fmt(cond.moldWholeWord)}) · water leak ${fmt(cond.waterLeak)}`);
console.log(`  homes in those buildings (legalclassa): ${fmt(homes.legalClassATotal)} across ${fmt(homes.buildingsFound)}/${fmt(homes.buildings)} buildings found`);
console.log(`  sample ${sample.address} (bbl ${SAMPLE_BBL}, buildingid ${sampleBuildingIds.join(",")}): ${fmt(sample.openInWindow)} in window, ${fmt(sample.openInWindowWithoutApartment)} without an apartment, legalclassa ${fmt(sample.legalClassATotal)}`);
console.log(`    FALSE / INVALID since ${SAMPLE_FALSE_SINCE}: ${sample.falseOrInvalidCount}`);
for (const r of sample.falseOrInvalid) console.log(`      #${r.violationid} ${r.currentstatus} ${r.currentstatusdate} class ${r.class}`);
console.log(`  #${violation.violationid}: ${violation.currentstatus} ${violation.currentstatusdate} class ${violation.class}; 70 days run out ${violation.seventyDaysRunOut}`);
console.log(`  last ${RECENT_DAYS} days (${last30.from}..${last30.to}): FALSE ${fmt(last30.falseCertification)} + INVALID ${fmt(last30.invalidCertification)} = ${fmt(last30.total)}`);
console.log(`  ${queries.length} queries -> ${file}`);
