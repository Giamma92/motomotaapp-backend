const express = require('express');
const router = express.Router();
const db = require('../models/db');
const authMiddleware = require('../middleware/authMiddleware');
const authorizeRoles = require('../middleware/authorizeRoles');

// ---- CONFIG -----------------------------------------------------------------
const PULSELIVE_BASE = "https://api.pulselive.motogp.com/motogp";
const MOTOGP_CATEGORY_UUID = "e8c110ad-64aa-4e8e-8a86-f2f152f6a942"; // MotoGP™

// MotoGP points (used for qualifying Q1/Q2). Sprint/Race points come from API's `.points`.
const pointsTable = {
    1: 25, 2: 20, 3: 16, 4: 13, 5: 11,
    6: 10, 7: 9, 8: 8, 9: 7, 10: 6,
    11: 5, 12: 4, 13: 3, 14: 2, 15: 1,
};
const qPoints = (pos) => pointsTable[pos] ?? 0;

// ---- HELPERS ----------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJSON(url, opts) {
    const timeoutMs = (opts && opts.timeoutMs) || 10000;
    const retries = (opts && opts.retries) || 2;

    for (let attempt = 0; ; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { Accept: "application/json" },
        });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        return await res.json();
        } catch (err) {
        clearTimeout(timer);
        if (attempt >= retries) throw err;
        await sleep(300 * (attempt + 1));
        }
    }
}

async function getSeasonUuidByYear(year) {
    const seasons = await fetchJSON(`${PULSELIVE_BASE}/v1/results/seasons`);
    const season = seasons.find((s) => s.year === Number(year));
    if (!season) throw new Error(`Pulselive: season ${year} not found`);
    return season.id;
}

async function getEventByCode(seasonUuid, code) {
    const events = await fetchJSON(
        `${PULSELIVE_BASE}/v1/results/events?seasonUuid=${seasonUuid}&isFinished=true`
    );
    const target = String(code).toUpperCase();
    const event = events.find(
        (e) => (e.short_name || (e.country && e.country.iso) || "").toUpperCase() === target
    );
    if (!event) throw new Error(`Pulselive: event with code ${target} not found`);
    return event;
}

async function getSessions(eventUuid, categoryUuid) {
    return fetchJSON(
        `${PULSELIVE_BASE}/v1/results/sessions?eventUuid=${eventUuid}&categoryUuid=${categoryUuid}`
    );
}

async function getClassification(sessionUuid) {
    if (!sessionUuid) return [];
    const data = await fetchJSON(
        `${PULSELIVE_BASE}/v2/results/classifications?session=${sessionUuid}&test=false`
    );
    return Array.isArray(data.classification) ? data.classification : [];
}

// Apply Q1 rule: skip top 2; add +10 to position for the rest.
function adjustQ1(rows) {
    return rows
        .map((row, idx) => ({ row, idx }))
        .filter(({ idx }) => idx >= 2)
        .map(({ row }) => ({
        ...row,
        position: Number(row.position) + 10,
        }));
}

function mergeSessions(q1, q2, spr, rac) {
    const byRider = new Map();

    const up = (rows, kind) => {
        for (const r of rows) {
            const riderUuid = r.rider && r.rider.id;
            if (!riderUuid) continue;

            const cur =
                byRider.get(riderUuid) ||
                {
                    riderUuid,
                    riderNumber: r.rider.number,
                    riderName: r.rider.full_name,
                    teamName: r.team_name,
                };

                const pos = Number(r.position);
                if (kind === "q1") cur.q1 = { position: pos, points: qPoints(pos) };
                if (kind === "q2") cur.q2 = { position: pos, points: qPoints(pos) };
                if (kind === "spr") cur.spr = { position: pos, points: r.points };
                if (kind === "rac") cur.rac = { position: pos, points: r.points };

                byRider.set(riderUuid, cur);
        }
    };

    up(q1, "q1");
    up(q2, "q2");
    up(spr, "spr");
    up(rac, "rac");

    const merged = Array.from(byRider.values()).sort((a, b) => {
        const ord = (x) =>
        (x.rac && x.rac.position) ??
        (x.spr && x.spr.position) ??
        (x.q2 && x.q2.position) ??
        (x.q1 && x.q1.position) ??
        999;
        return ord(a) - ord(b);
    });

    return merged;
}

function buildUpserts(merged, championshipId, calendarId, riderNumberToId) {
    const out = [];
    for (const r of merged) {
        const riderId = riderNumberToId.get(Number(r.riderNumber));
        if (!riderId) continue;

        out.push({
            championship_id: championshipId,
            calendar_id: calendarId,
            rider_id: riderId,
            qualifying_position: (r.q1 && r.q1.position) || (r.q2 && r.q2.position) || null,
            qualifying_points: (r.q1 && r.q1.points) || (r.q2 && r.q2.points) || null,
            sprint_position: (r.spr && r.spr.position) || null,
            sprint_points: (r.spr && r.spr.points) || null,
            race_position: (r.rac && r.rac.position) || null,
            race_points: (r.rac && r.rac.points) || null,
            last_modification_at: new Date().toISOString()
        });
    }
    return out;
}

/**
 * GET /championship/:id/calendar/:calendar_id/motogp-results/?upsert=true|false
 * Returns merged results (Q1, Q2, SPR, RAC) from Pulselive.
 * If upsert=true, also writes into motogp_results (on conflict (championship_id, calendar_id, rider_id)).
 */
router.get(
"/championship/:id/calendar/:calendar_id/motogp-results/",
authMiddleware,
async (req, res) => {
    try {
        const championshipId = Number(req.params.id);
        const calendarId = Number(req.params.calendar_id);
        const doUpsert = String(req.query.upsert || "").toLowerCase() === "true";

        // 1) read championship year & event code from your DB
        const { data: champ, error: ce } = await db
            .from("championships")
            .select("year")
            .eq("id", championshipId)
            .maybeSingle();
        if (ce || !champ) return res.status(400).json({ error: "championship not found" });

        const { data: cal, error: cale } = await db
            .from("calendar")
            .select("race_id(name,location,country)")
            .eq("id", calendarId)
            .maybeSingle();
        if (cale || !cal || !cal.race_id)
            return res.status(400).json({ error: "calendar not found" });

        const eventCode = String(cal.race_id.country).toUpperCase();
        if (!eventCode) return res.status(400).json({ error: "event code missing" });

        // 2) Pulselive lookups
        const seasonUuid = await getSeasonUuidByYear(Number(champ.year));
        const event = await getEventByCode(seasonUuid, eventCode);
        const sessions = await getSessions(event.id, MOTOGP_CATEGORY_UUID);

        const find = (t) => {
            
            let s;
            if (t === 'Q1' || t === 'Q2') {
                const n = (t === "Q1") ? 1 : (t === "Q2") ? 2 : null;
                s = sessions.find((x) => String(x.type || "").toUpperCase() === String(t).substring(0,1) && x.number === n);
            } else 
                s = sessions.find((x) => String(x.type || "").toUpperCase() === String(t));
            return s && s.id;
        };
        const [q1Id, q2Id, sprId, racId] = ["Q1", "Q2", "SPR", "RAC"].map(find);

        const [q1Raw, q2Raw, sprRaw, racRaw] = await Promise.all([
            getClassification(q1Id),
            getClassification(q2Id),
            getClassification(sprId),
            getClassification(racId),
        ]);

        const q1Adj = adjustQ1(q1Raw);
        const merged = mergeSessions(q1Adj, q2Raw, sprRaw, racRaw);

        // 3) Optional upsert into motogp_results
        const userRoleNames = req.roles || [];
        const hasRoleAdmin = userRoleNames.includes("Admin");
        let upserted = 0;
        if (doUpsert && hasRoleAdmin) {

            const { data: riders } = await db
            .from("championship_riders")
            .select("rider_id(id, number)")
            .eq("championship_id", championshipId);

            const riderNumberToId = new Map();
            (riders || []).forEach((r) => {
            if (r && r.rider_id && r.rider_id.number)
                riderNumberToId.set(Number(r.rider_id.number), r.rider_id.id);
            });
            const rows = buildUpserts(merged, championshipId, calendarId, riderNumberToId);

            if (rows.length) {
                const { error } = await db
                    .from("motogp_results")
                    .upsert(rows, { onConflict: "championship_id,calendar_id,rider_id" });
                if (error) throw error;
                upserted = rows.length;
            }
        }

        return res.json({
            meta: {
            championshipId,
            calendarId,
            year: Number(champ.year),
            eventCode,
            pulselive: { seasonUuid, eventUuid: event.id },
            },
            sessions: { Q1: q1Adj, Q2: q2Raw, SPR: sprRaw, RAC: racRaw },
            merged,
            upserted,
        });
        } catch (err) {
            return res.status(502).json({ error: (err && err.message) || String(err) });
        }
    }
);

module.exports = router;