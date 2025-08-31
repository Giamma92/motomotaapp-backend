// routes/lineups.js
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const authMiddleware = require('../middleware/authMiddleware');

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
            user_id(first_name,last_name),
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
            querySprintBets = querySprintBets.eq('calendar_id', calendarId).eq('user_id', user_id);
        }

        if (!allUsers) {
            querySprintBets = querySprintBets.eq('user_id', user_id);
        }

        const { data: sprints, error: sprintsError } = await querySprintBets.select(`id,
                championship_id,
                calendar_id(race_id(name,location)),
                user_id(first_name,last_name),
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
            queryRaceBets = queryRaceBets.eq('calendar_id', calendarId).eq('user_id', user_id);
        }

        if (!allUsers) {
            queryRaceBets = queryRaceBets.eq('user_id', user_id);
        }

        const { data: bets, error: betsError } = await queryRaceBets.select(`
                id,
                championship_id,
                calendar_id(race_id(name,location)),
                user_id(first_name,last_name),
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

module.exports = router;