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

    try {
        // Query lineups results for the given race and championship
        const { data: lineups, error: lineupsError } = await db
            .from('lineups')
            .select(`id,
                    championship_id,
                    calendar_id(race_id(name,location)),
                    user_id(first_name,last_name),
                    race_rider_id(first_name, last_name),
                    qualifying_rider_id(first_name, last_name),
                    inserted_at`)
            .eq('championship_id', championshipId)
            .eq('calendar_id', calendarId);
        
        if (lineupsError) {
            console.error('Error fetching lineups:', lineupsError);
            return res.status(500).json({ error: lineupsError.message });
        }

        // Query sprint-bet results for the given race and championship
        const { data: sprints, error: sprintsError } = await db
            .from('sprint_bets')
            .select(`id,
                    championship_id,
                    calendar_id(race_id(name,location)),
                    user_id(first_name,last_name),
                    rider_id(first_name, last_name),
                    position,
                    points,
                    inserted_at,
                    outcome`)
            .eq('championship_id', championshipId)
            .eq('calendar_id', calendarId);
        
        if (sprintsError) {
            console.error('Error fetching sprint bets:', sprintsError);
            return res.status(500).json({ error: sprintsError.message });
        }

        // Query bet results for the given race and championship
        const { data: bets, error: betsError } = await db
            .from('bets')
            .select(`id,
                championship_id,
                calendar_id(race_id(name,location)),
                user_id(first_name,last_name),
                rider_id(first_name, last_name),
                position,
                points,
                inserted_at,
                outcome`)
            .eq('championship_id', championshipId)
            .eq('calendar_id', calendarId);
        
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