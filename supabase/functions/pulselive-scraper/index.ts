// supabase/functions/pulselive-scraper/index.ts

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PULSELIVE_BASE = "https://api.pulselive.motogp.com/motogp";
const MOTOGP_CATEGORY_UUID = "e8c110ad-64aa-4e8e-8a86-f2f152f6a942";

// Points table for MotoGP qualifying (Q1/Q2)
function getMotoGPPoints(pos: number): number {
  const table: Record<number, number> = {
    1: 25, 2: 20, 3: 16, 4: 13, 5: 11,
    6: 10, 7: 9, 8: 8, 9: 7, 10: 6,
    11: 5, 12: 4, 13: 3, 14: 2, 15: 1
  };
  return table[pos] ?? 0;
}

// Helper to log messages to function_logs
async function logToSupabase(supabase: any, level: string, message: string) {
  await supabase.from("function_logs").insert({ level, message }).catch(() => {});
}

// Helper to perform fetch with a timeout
async function fetchWithTimeout(url: string, timeoutMs = 10000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req: Request): Promise<Response> {
  const supabase = createClient(supabaseUrl, supabaseKey);

  // Parse and validate input
  let payload;
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400 });
  }
  const championshipId = Number(payload.championshipId);
  const calendarId = Number(payload.calendarId);
  const sessionType = String(payload.sessionType || "").toUpperCase();

  // Validate sessionType immediately before doing anything else
  const allowed = ["Q1", "Q2", "SPR", "RAC"];
  if (!allowed.includes(sessionType)) {
    return new Response(
      JSON.stringify({ error: `sessionType must be one of ${allowed.join(", ")}` }),
      { status: 400 }
    );
  }

  // Fetch year and country ISO from your tables
  const { data: championship } = await supabase
    .from("championships")
    .select("year")
    .eq("id", championshipId)
    .maybeSingle();
  const { data: calendar } = await supabase
    .from("calendar")
    .select("race_id(country, short_name)")
    .eq("id", calendarId)
    .maybeSingle();
  if (!championship || !calendar || !calendar.race_id) {
    return new Response(JSON.stringify({ error: "Invalid championship or calendar" }), { status: 400 });
  }
  const year = championship.year;
  // Use short_name if present, otherwise fall back to country ISO
  const countryShort = (calendar.race_id.short_name || calendar.race_id.country?.iso || "").toUpperCase();
  if (!countryShort) {
    return new Response(JSON.stringify({ error: "Cannot determine race short name" }), { status: 400 });
  }

  // 1. Get season for this year
  let seasons;
  try {
    const seasonsRes = await fetchWithTimeout(`${PULSELIVE_BASE}/v1/results/seasons`);
    seasons = await seasonsRes.json();
  } catch {
    return new Response(JSON.stringify({ error: "Failed to fetch seasons" }), { status: 502 });
  }
  const season = seasons.find((s: any) => s.year === year);
  if (!season) {
    return new Response(JSON.stringify({ error: `Season for year ${year} not found` }), { status: 404 });
  }

  // 2. Get events for the season and find by short name
  let events;
  try {
    const eventsRes = await fetchWithTimeout(
      `${PULSELIVE_BASE}/v1/results/events?seasonUuid=${season.id}&isFinished=true`
    );
    events = await eventsRes.json();
  } catch {
    return new Response(JSON.stringify({ error: "Failed to fetch events" }), { status: 502 });
  }
  const event = events.find(
    (e: any) => (e.short_name || e.country?.iso || "").toUpperCase() === countryShort
  );
  if (!event) {
    return new Response(JSON.stringify({ error: `Event with code ${countryShort} not found` }), { status: 404 });
  }

  // 3. Get sessions for this event
  let sessions;
  try {
    const sessionsRes = await fetchWithTimeout(
      `${PULSELIVE_BASE}/v1/results/sessions?eventUuid=${event.id}&categoryUuid=${MOTOGP_CATEGORY_UUID}`
    );
    sessions = await sessionsRes.json();
  } catch {
    return new Response(JSON.stringify({ error: "Failed to fetch sessions" }), { status: 502 });
  }
  const session = sessions.find((s: any) => (s.type || "").toUpperCase() === sessionType);
  if (!session) {
    return new Response(
      JSON.stringify({ error: `Session type ${sessionType} not found for event` }),
      { status: 404 }
    );
  }

  // 4. Get classification for this session
  let classification;
  try {
    const classRes = await fetchWithTimeout(
      `${PULSELIVE_BASE}/v2/results/classifications?session=${session.id}&test=false`
    );
    const classJson = await classRes.json();
    classification = classJson.classification || [];
  } catch {
    return new Response(JSON.stringify({ error: "Failed to fetch classification" }), { status: 502 });
  }

  // 5. Build rider map (number -> id)
  const { data: riders } = await supabase
    .from("championship_riders")
    .select("rider_id(id, number)")
    .eq("championship_id", championshipId);
  const riderMap = new Map<string, number>();
  (riders ?? []).forEach((r) => {
    if (r.rider_id?.number) riderMap.set(String(r.rider_id.number), r.rider_id.id);
  });

  // 6. Build upsert records
  const upserts = [];
  for (let i = 0; i < classification.length; i++) {
    const entry = classification[i];
    const riderNum = String(entry.rider.number);
    const riderId = riderMap.get(riderNum);
    if (!riderId) continue;

    let pos = entry.position;
    // Q1 adjustment: skip first two riders and add 10 to remaining
    if (sessionType === "Q1") {
      if (i < 2) continue;
      pos = pos + 10;
    }

    const record: any = {
      championship_id: championshipId,
      calendar_id: calendarId,
      rider_id: riderId
    };

    if (sessionType === "Q1" || sessionType === "Q2") {
      record.qualifying_position = pos;
      record.qualifying_points = getMotoGPPoints(pos);
    } else if (sessionType === "SPR") {
      record.sprint_position = pos;
      record.sprint_points = entry.points;
    } else if (sessionType === "RAC") {
      record.race_position = pos;
      record.race_points = entry.points;
    }

    upserts.push(record);
  }

  // 7. Upsert into motogp_results
  if (upserts.length > 0) {
    await supabase
      .from("motogp_results")
      .upsert(upserts, { onConflict: "championship_id,calendar_id,rider_id" });
    await logToSupabase(
      supabase,
      "info",
      `Pulselive API: upserted ${upserts.length} rows (sessionType=${sessionType})`
    );
  } else {
    await logToSupabase(supabase, "warn", "No riders matched in classification");
  }

  return new Response(JSON.stringify({ inserted: upserts.length }), {
    headers: { "Content-Type": "application/json" }
  });
}
