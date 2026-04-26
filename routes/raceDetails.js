// routes/lineups.js
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const authMiddleware = require('../middleware/authMiddleware');
const authorizeRoles = require('../middleware/authorizeRoles');
const {
    DEFAULT_CHAMPIONSHIP_TIMEZONE,
    formatSqlTimestamp,
    normalizeTimeZone
} = require('../utils/championshipTime');

function getMotoGPPoints(position) {
    const table = {
        1: 25, 2: 20, 3: 16, 4: 13, 5: 11,
        6: 10, 7: 9, 8: 8, 9: 7, 10: 6,
        11: 5, 12: 4, 13: 3, 14: 2, 15: 1
    };
    return table[Number(position)] ?? 0;
}

/**
 * GET /api/championship/:championship_id/race-details/:calendar_id
 * Returns the lineups, sprint-bet, and bet results for the given race and championship.
 */
router.get('/championship/:championship_id/race-details/:calendar_id', authMiddleware, async (req, res) => {
    const championshipId = req.params.championship_id;
    const calendarId = req.params.calendar_id;
    const allCalendar = req.query.allCalendar == 'true';
    const allUsers = req.query.allUsers == 'true';
    const user_id = req.username;

    try {
        // Query lineups results for the given race and championship
        let queryLineups = db
            .from('lineups')
            .select()
            .eq('championship_id', championshipId)

        if (!allCalendar) {
            queryLineups = queryLineups.eq('calendar_id', calendarId);
        }

        if (!allUsers) {
            queryLineups = queryLineups.eq('user_id', user_id);
        }

        const { data: lineups, error: lineupsError } = await queryLineups.select(`
            id,
            championship_id,
            calendar_id(id,event_date,race_order,race_id(name,location)),
            user_id(id,first_name,last_name),
            race_rider_id(id,first_name, last_name,number),
            qualifying_rider_id(id,first_name, last_name,number),
            inserted_at,modified_at,
            automatically_inserted`);
        
        if (lineupsError) {
            console.error('Error fetching lineups:', lineupsError);
            return res.status(500).json({ error: lineupsError.message });
        }

        // Query sprint-bet results for the given race and championship
        let querySprintBets = db
            .from('sprint_bets')
            .select()
            .eq('championship_id', championshipId);

        if (!allCalendar) {
            querySprintBets = querySprintBets.eq('calendar_id', calendarId);
        }

        if (!allUsers) {
            querySprintBets = querySprintBets.eq('user_id', user_id);
        }

        const { data: sprints, error: sprintsError } = await querySprintBets.select(`id,
                championship_id,
                calendar_id(id,event_date,race_order,race_id(name,location)),
            user_id(id,first_name,last_name),
                rider_id(id,first_name, last_name,number),
                position,
                points,
                inserted_at,modified_at,
                outcome`
        );

        
        if (sprintsError) {
            console.error('Error fetching sprint bets:', sprintsError);
            return res.status(500).json({ error: sprintsError.message });
        }

        // Query bet results for the given race and championship
        let queryRaceBets = db
            .from('race_bets')
            .select()
            .eq('championship_id', championshipId);

        if (!allCalendar) {
            queryRaceBets = queryRaceBets.eq('calendar_id', calendarId);
        }

        if (!allUsers) {
            queryRaceBets = queryRaceBets.eq('user_id', user_id);
        }

        const { data: bets, error: betsError } = await queryRaceBets.select(`
                id,
                championship_id,
                calendar_id(id,event_date,race_order,race_id(name,location)),
            user_id(id,first_name,last_name),
                rider_id(id,first_name, last_name,number),
                position,
                points,
                inserted_at,modified_at,
                outcome`);
        
        if (betsError) {
            console.error('Error fetching bet results:', betsError);
            return res.status(500).json({ error: betsError.message });
        }

        const { data: motogpResults, error: motogpResultsError } = await db
            .from('motogp_results')
            .select(`
                id,
                championship_id,
                calendar_id,
                rider_id(id,first_name,last_name,number),
                qualifying_position,
                qualifying_points,
                qualifying_scoring_position,
                qualifying_scoring_points,
                qualifying_scoring_source,
                sprint_position,
                sprint_points,
                race_position,
                race_points
            `)
            .eq('championship_id', championshipId)
            .eq('calendar_id', calendarId)
            .order('qualifying_position', { ascending: true, nullsFirst: false });

        if (motogpResultsError) {
            console.error('Error fetching MotoGP stored results:', motogpResultsError);
            return res.status(500).json({ error: motogpResultsError.message });
        }

         // Return the combined results
        res.json({ lineups, sprints, bets, motogpResults });
        } 
        catch (err) {
            console.error('Unexpected error:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
});

/**
 * GET /api/championship/:championship_id/races/:calendar_id/fill-missing-lineups
 * Copy each missing user's latest available lineup before the current race.
 */
router.get('/championship/:championship_id/races/:calendar_id/fill-missing-lineups', authMiddleware, authorizeRoles('Admin'), async (req, res) => {
    try {
        const championshipId = req.params.championship_id;
        const calendarId = req.params.calendar_id;
    
        // 1) Current race date
        const { data: currRace, error: currErr } = await db
            .from('calendar')
            .select('id,event_date,cancelled')
            .eq('id', calendarId)
            .single();
        if (currErr || !currRace) return res.status(404).json({ error: 'Current race not found' });
        if (currRace.cancelled) return res.status(400).json({ error: 'Race has been cancelled.' });
    
        // 2) Existing current race lineups (to avoid duplicates)
        const { data: currLineups, error: currLineupsErr } = await db
            .from('lineups')
            .select('user_id')
            .eq('championship_id', championshipId)
            .eq('calendar_id', calendarId);
        if (currLineupsErr) return res.status(500).json({ error: currLineupsErr.message });

        // 3) Only users participating in the championship need an automatic lineup.
        const { data: fantasyTeams, error: fantasyTeamsErr } = await db
            .from('fantasy_teams')
            .select('user_id')
            .eq('championship_id', championshipId);
        if (fantasyTeamsErr) return res.status(500).json({ error: fantasyTeamsErr.message });

        const existing = new Set((currLineups ?? []).map(r => r.user_id));
        const missingUserIds = (fantasyTeams ?? [])
            .map(team => team.user_id)
            .filter(userId => userId && !existing.has(userId));

        if (!missingUserIds.length) {
            return res.status(200).json({
                inserted: 0,
                missingUsers: 0,
                withoutPreviousLineup: 0,
                message: 'All users already have lineups'
            });
        }

        // 4) Load all previous lineups for missing users and keep the latest per user.
        const { data: previousLineups, error: previousLineupsErr } = await db
            .from('lineups')
            .select('user_id,qualifying_rider_id,race_rider_id,calendar_id(id,event_date)')
            .eq('championship_id', championshipId)
            .in('user_id', missingUserIds);
        if (previousLineupsErr) return res.status(500).json({ error: previousLineupsErr.message });

        const latestLineupByUser = new Map();
        const orderedPreviousLineups = (previousLineups ?? [])
            .filter(lineup => lineup.calendar_id?.event_date && lineup.calendar_id.event_date < currRace.event_date)
            .sort((left, right) => right.calendar_id.event_date.localeCompare(left.calendar_id.event_date));

        for (const lineup of orderedPreviousLineups) {
            if (!lineup.calendar_id || latestLineupByUser.has(lineup.user_id)) continue;
            latestLineupByUser.set(lineup.user_id, lineup);
        }

        const { data: config } = await db
            .from('configuration')
            .select('timezone')
            .eq('championship_id', championshipId)
            .maybeSingle();
        const championshipTimeZone = normalizeTimeZone(config?.timezone || DEFAULT_CHAMPIONSHIP_TIMEZONE);
        const modifiedAt = formatSqlTimestamp(new Date(), championshipTimeZone);
    
        // 5) Prepare inserts from each user's latest available lineup.
        const rows = missingUserIds
            .map(userId => latestLineupByUser.get(userId))
            .filter(Boolean)
            .map(lineup => ({
            championship_id: championshipId,
            calendar_id: calendarId,
            user_id: lineup.user_id,
            qualifying_rider_id: lineup.qualifying_rider_id,
            race_rider_id: lineup.race_rider_id,
            modified_at: modifiedAt,
            automatically_inserted: true
            }));

        if (!rows.length) {
            return res.status(200).json({
                inserted: 0,
                missingUsers: missingUserIds.length,
                withoutPreviousLineup: missingUserIds.length,
                message: 'No previous lineups found for missing users'
            });
        }
    
        const { error: insertErr, count } = await db
            .from('lineups')
            .upsert(rows, { onConflict: 'championship_id,user_id,calendar_id', count: 'exact' });
        if (insertErr) return res.status(500).json({ error: insertErr.message });
    
        return res.status(200).json({
            inserted: count ?? rows.length,
            missingUsers: missingUserIds.length,
            withoutPreviousLineup: missingUserIds.length - rows.length,
            message: `Inserted ${count ?? rows.length} automatic lineups`
        });
        
    } catch (e) {
        console.error(e);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

    /**
   * POST /api/championship/:championship_id/races/:calendar_id/bets/:kind/outcome
   * Bulk set outcome (true/false) for sprint or race bets of the current race.
   * kind: "sprint" | "race"
   * body: { outcome: boolean | "true" | "false" }
   */
router.post('/championship/:championship_id/races/:calendar_id/bets/:kind/outcome', authMiddleware, authorizeRoles('Admin'), async (req, res) => {
    try {
        const championshipId = req.params.championship_id;
        const calendarId = req.params.calendar_id;
        const kind = String(req.params.kind || '').toLowerCase();
        const rawOutcome = req.body?.outcome;
        const betIds = Array.isArray(req.body?.betIds) ? req.body.betIds : undefined;

        if (!['sprint', 'race'].includes(kind)) {
            return res.status(400).json({ error: 'Invalid kind. Use "sprint" or "race".' });
        }

        const outcome =
        typeof rawOutcome === 'boolean'
            ? rawOutcome
            : String(rawOutcome).toLowerCase() === 'true';

        const table = kind === 'sprint' ? 'sprint_bets' : 'race_bets';

        const query = db
            .from(table)
            .update({ outcome: outcome ? 'true' : 'false' })
            .eq('championship_id', championshipId)
            .eq('calendar_id', calendarId)

        if (betIds?.length) {
            query = query.in('id', betIds);  // <-- only selected bets
        }

        const { data, error } = await query.select('id');

        if (error) return res.status(500).json({ error: error.message });

        return res.status(200).json({ updated: data?.length ?? 0 });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

router.post('/championship/:championship_id/races/:calendar_id/qualifying-scoring', authMiddleware, authorizeRoles('Admin'), async (req, res) => {
    try {
        const championshipId = req.params.championship_id;
        const calendarId = req.params.calendar_id;
        const riderId = Number(req.body?.riderId);
        const scoringPosition = req.body?.qualifyingScoringPosition;

        if (!Number.isFinite(riderId)) {
            return res.status(400).json({ error: 'Invalid riderId' });
        }

        const resetRequested = scoringPosition === null || scoringPosition === undefined || String(scoringPosition).trim() === '';

        const { data: existing, error: existingError } = await db
            .from('motogp_results')
            .select('id, qualifying_position, qualifying_points')
            .eq('championship_id', championshipId)
            .eq('calendar_id', calendarId)
            .eq('rider_id', riderId)
            .maybeSingle();

        if (existingError) {
            return res.status(500).json({ error: existingError.message });
        }

        if (!existing) {
            return res.status(404).json({ error: 'MotoGP result not found for rider' });
        }

        const payload = resetRequested
            ? {
                qualifying_scoring_position: existing.qualifying_position,
                qualifying_scoring_points: existing.qualifying_points ?? 0,
                qualifying_scoring_source: 'raw_qualifying'
            }
            : {
                qualifying_scoring_position: Number(scoringPosition),
                qualifying_scoring_points: getMotoGPPoints(Number(scoringPosition)),
                qualifying_scoring_source: 'admin_override'
            };

        if (!resetRequested && (!Number.isFinite(payload.qualifying_scoring_position) || payload.qualifying_scoring_position <= 0)) {
            return res.status(400).json({ error: 'Invalid qualifyingScoringPosition' });
        }

        const { data, error } = await db
            .from('motogp_results')
            .update(payload)
            .eq('id', existing.id)
            .select(`
                id,
                championship_id,
                calendar_id,
                rider_id(id,first_name,last_name,number),
                qualifying_position,
                qualifying_points,
                qualifying_scoring_position,
                qualifying_scoring_points,
                qualifying_scoring_source
            `)
            .maybeSingle();

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        return res.status(200).json({ result: data });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ error: 'Internal server error' });
    }
});


module.exports = router;
