// routes/lineups.js
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const authMiddleware = require('../middleware/authMiddleware');
const authorizeRoles = require('../middleware/authorizeRoles');

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
            calendar_id(race_id(name,location)),
            user_id(id,first_name,last_name),
            race_rider_id(id,first_name, last_name,number),
            qualifying_rider_id(id,first_name, last_name,number),
            inserted_at,modified_at`);
        
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
                calendar_id(race_id(name,location)),
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
                calendar_id(race_id(name,location)),
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

         // Return the combined results
        res.json({ lineups, sprints, bets });
        } 
        catch (err) {
            console.error('Unexpected error:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
});

/**
 * GET /api/championship/:championship_id/races/:calendar_id/fill-missing-lineups
 * Copy previous race lineups for users missing a lineup in the current race.
 */
router.get('/championship/:championship_id/races/:calendar_id/fill-missing-lineups', authMiddleware, authorizeRoles('Admin'), async (req, res) => {
    try {
        const championshipId = req.params.championship_id;
        const calendarId = req.params.calendar_id;
    
        // 1) Current race date
        const { data: currRace, error: currErr } = await db
            .from('calendar')
            .select('id,event_date')
            .eq('id', calendarId)
            .single();
        if (currErr || !currRace) return res.status(404).json({ error: 'Current race not found' });
    
        // 2) Previous race in same championship
        const { data: prevRace, error: prevErr } = await db
            .from('calendar')
            .select('id,event_date')
            .eq('championship_id', championshipId)
            .lt('event_date', currRace.event_date)
            .order('event_date', { ascending: false })
            .limit(1)
            .maybeSingle();
        if (prevErr) return res.status(500).json({ error: prevErr.message });
        if (!prevRace) return res.status(200).json({ inserted: 0, message: 'No previous race found' });
    
        // 3) Previous race lineups
        const { data: prevLineups, error: prevLineupsErr } = await db
            .from('lineups')
            .select('user_id,qualifying_rider_id,race_rider_id')
            .eq('championship_id', championshipId)
            .eq('calendar_id', prevRace.id);
        if (prevLineupsErr) return res.status(500).json({ error: prevLineupsErr.message });
    
        if (!prevLineups?.length) return res.status(200).json({ inserted: 0, message: 'No previous lineups' });
    
        // 4) Existing current race lineups (to avoid duplicates)
        const { data: currLineups, error: currLineupsErr } = await db
            .from('lineups')
            .select('user_id')
            .eq('championship_id', championshipId)
            .eq('calendar_id', calendarId);
        if (currLineupsErr) return res.status(500).json({ error: currLineupsErr.message });
    
        const existing = new Set((currLineups ?? []).map(r => r.user_id));
    
        // 5) Prepare inserts
        const rows = prevLineups
            .filter(r => !existing.has(r.user_id))
            .map(r => ({
            championship_id: championshipId,
            calendar_id: calendarId,
            user_id: r.user_id,
            qualifying_rider_id: r.qualifying_rider_id,
            race_rider_id: r.race_rider_id,
            modified_at: new Date().toISOString(),
            automatically_inserted: true
            }));
    
        if (!rows.length) return res.status(200).json({ inserted: 0, message: 'All users already have lineups' });
    
        const { error: insertErr, count } = await db
            .from('lineups')
            .insert(rows, { count: 'exact' });
        if (insertErr) return res.status(500).json({ error: insertErr.message });
    
        return res.status(200).json({ inserted: count ?? rows.length });
        
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


module.exports = router;