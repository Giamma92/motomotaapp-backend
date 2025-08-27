// supabase/functions/motogp-scraper/index.ts

import puppeteer from "npm:puppeteer-core";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Use Supabase‑injected environment variables (do not create secrets with these names)
const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Custom secret: a Browserless WebSocket URL with your token
const browserlessWs = Deno.env.get("BROWSERLESS_WS_ENDPOINT")!;

/**
 * MotoGP points table (positions 1–15)
 */
function getMotoGPPoints(position: number): number {
  const table: Record<number, number> = {
    1: 25, 2: 20, 3: 16, 4: 13, 5: 11,
    6: 10, 7: 9, 8: 8, 9: 7, 10: 6,
    11: 5, 12: 4, 13: 3, 14: 2, 15: 1,
  };
  return table[position] ?? 0;
}

interface ClassificationRow {
  position: number;
  points: number;
  rider_number: string;
  rider_name: string;
  team: string;
}

interface PartialResult {
  rider_id: number;
  championship_id: number;
  calendar_id: number;
  qualifying_position?: number;
  qualifying_points?: number;
  sprint_position?: number;
  sprint_points?: number;
  race_position?: number;
  race_points?: number;
}

/**
 * Merge partial results into consolidated records keyed by championship/rider/calendar.
 * Later numeric properties are copied only if undefined in existing entry.
 */
function mergeResults(data: PartialResult[]): PartialResult[] {
  const merged: Record<string, PartialResult> = {};
  for (const item of data) {
    const key = `${item.championship_id}-${item.rider_id}-${item.calendar_id}`;
    if (!merged[key]) {
      merged[key] = { ...item };
    } else {
      for (const [prop, value] of Object.entries(item)) {
        if (["championship_id", "rider_id", "calendar_id"].includes(prop)) continue;
        const numeric = value as number | undefined;
        if (numeric !== undefined && merged[key][prop as keyof PartialResult] === undefined) {
          merged[key][prop as keyof PartialResult] = numeric;
        }
      }
    }
  }
  return Object.values(merged);
}

/**
 * Scrape classification data from a MotoGP results page using an existing browser.
 * Creates a new page, navigates to the URL with shorter timeouts and extracts rows.
 */
async function scrapePage(
  browser: puppeteer.Browser,
  url: string
): Promise<ClassificationRow[]> {
  const page = await browser.newPage();
  try {
    // Go to the page; use shorter timeouts to stay within function limit.
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    // Wait for the table; if it doesn’t show up in 15 s, throw and return empty.
    await page.waitForSelector(".results-table__table", { timeout: 15000 });
    // Extract rows on the page.
    const rows = await page.evaluate(() => {
      return Array.from(document.querySelectorAll(".results-table__table tbody .results-table__body-row"))
        .map((row) => {
          const getText = (selector: string) =>
            (row.querySelector(selector)?.textContent || "").trim();
          return {
            position: Number(getText(".results-table__body-cell--pos") || "0"),
            points: Number(getText(".results-table__body-cell--points") || "0"),
            rider_number: getText(".results-table__body-cell--number"),
            rider_name: getText(".results-table__body-cell--full-name"),
            team: getText(".results-table__body-cell--team"),
          };
        });
    });
    return rows;
  } catch (_err) {
    // If any error (timeout, missing selector, etc.) occurs, return empty array
    return [];
  } finally {
    await page.close();
  }
}

/**
 * Insert a log record into function_logs; ignore errors silently.
 */
async function logToSupabase(supabase: any, level: string, message: string) {
  await supabase.from("function_logs").insert({ level, message }).catch(() => {});
}

export default async function handler(req: Request): Promise<Response> {
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  // Parse JSON payload containing championshipId and calendarId
  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
  }
  const championshipId = Number(body.championshipId);
  const calendarId = Number(body.calendarId);

  // Fetch championship year
  const { data: championship, error: champErr } = await supabase
    .from("championships")
    .select("id, year")
    .eq("id", championshipId)
    .maybeSingle();
  if (champErr || !championship) {
    await logToSupabase(supabase, "error", `championship ${championshipId} not found`);
    return new Response(JSON.stringify({ error: "championship not found" }), { status: 404 });
  }

  // Fetch calendar race and country code
  const { data: calendar, error: calErr } = await supabase
    .from("calendar")
    .select("id, race_id(country)")
    .eq("id", calendarId)
    .maybeSingle();
  if (calErr || !calendar || !calendar.race_id?.country) {
    await logToSupabase(supabase, "error", `calendar ${calendarId} not found`);
    return new Response(JSON.stringify({ error: "calendar not found" }), { status: 404 });
  }

  const year = championship.year;
  const country = calendar.race_id.country;
  const baseUrl = `https://www.motogp.com/it/gp-results/${year}/${country}/motogp`;

  // Load riders for this championship and build a map from rider number to rider_id
  const { data: riders, error: ridersErr } = await supabase
    .from("championship_riders")
    .select("rider_id(id, number)")
    .eq("championship_id", championshipId);
  if (ridersErr) {
    await logToSupabase(supabase, "error", `error loading riders: ${ridersErr.message}`);
    return new Response(JSON.stringify({ error: "failed to load riders" }), { status: 500 });
  }
  const riderMap = new Map<string, number>();
  (riders ?? []).forEach((r) => {
    if (r.rider_id?.number) {
      riderMap.set(String(r.rider_id.number), r.rider_id.id);
    }
  });

  // Connect once to Browserless and scrape all four pages concurrently
  const browser = await puppeteer.connect({ browserWSEndpoint: browserlessWs });
  const [q1Data, q2Data, sprData, racData] = await Promise.all([
    scrapePage(browser, `${baseUrl}/q1/classification`),
    scrapePage(browser, `${baseUrl}/q2/classification`),
    scrapePage(browser, `${baseUrl}/spr/classification`),
    scrapePage(browser, `${baseUrl}/rac/classification`)
  ]);
  await browser.close();

  // Aggregate partial results
  const partials: PartialResult[] = [];

  // Process qualifying: Q1 + Q2 with the +10 position shift for Q1 (slice first 2)
  if (q1Data.length && q2Data.length) {
    const q1Fixed = q1Data.slice(2).map((q) => ({
      position: q.position + 10,
      points: q.points,
      rider_number: q.rider_number,
      rider_name: q.rider_name,
      team: q.team
    }));
    const qualifyingData = [...q2Data, ...q1Fixed];
    for (const row of qualifyingData) {
      const riderId = riderMap.get(row.rider_number);
      if (!riderId) continue;
      partials.push({
        rider_id: riderId,
        championship_id: championshipId,
        calendar_id: calendarId,
        qualifying_position: row.position,
        qualifying_points: getMotoGPPoints(row.position)
      });
    }
    await logToSupabase(supabase, "info", `processed ${qualifyingData.length} qualifying rows`);
  }

  // Process sprint
  if (sprData.length) {
    for (const row of sprData) {
      const riderId = riderMap.get(row.rider_number);
      if (!riderId) continue;
      partials.push({
        rider_id: riderId,
        championship_id: championshipId,
        calendar_id: calendarId,
        sprint_position: row.position,
        sprint_points: row.points
      });
    }
    await logToSupabase(supabase, "info", `processed ${sprData.length} sprint rows`);
  }

  // Process race
  if (racData.length) {
    for (const row of racData) {
      const riderId = riderMap.get(row.rider_number);
      if (!riderId) continue;
      partials.push({
        rider_id: riderId,
        championship_id: championshipId,
        calendar_id: calendarId,
        race_position: row.position,
        race_points: row.points
      });
    }
    await logToSupabase(supabase, "info", `processed ${racData.length} race rows`);
  }

  // Merge duplicates (one entry per rider/calendar) and upsert
  const merged = mergeResults(partials);
  const { error: upsertErr } = await supabase
    .from("motogp_results")
    .upsert(merged, { onConflict: "championship_id,calendar_id,rider_id" });

  if (upsertErr) {
    await logToSupabase(supabase, "error", `upsert error: ${upsertErr.message}`);
    return new Response(JSON.stringify({ error: "database upsert failed" }), { status: 500 });
  }

  await logToSupabase(supabase, "info", `upserted ${merged.length} rows into motogp_results`);
  return new Response(JSON.stringify({ inserted: merged.length }), {
    headers: { "Content-Type": "application/json" }
  });
}
