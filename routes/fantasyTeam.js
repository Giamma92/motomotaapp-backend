const express = require('express');
const router = express.Router();
const db = require('../models/db');
const authMiddleware = require('../middleware/authMiddleware');

// GET /championship/:championship_id/fantasy_team
// Returns the fantasy team for the logged‑in user filtered by championship_id
router.get('/championship/:championship_id/fantasy_team', authMiddleware, async (req, res) => {
    const championshipId = req.params.championship_id;
    const username = req.username; // Provided by authMiddleware

    try {
        const { data, error } = await db
            .from('fantasy_teams')
            .select(`id,
                    name,
                    team_image,
                    official_rider_1(id,first_name,last_name,number),
                    official_rider_2(id,first_name,last_name,number),
                    reserve_rider(id,first_name,last_name,number)`)
            .eq('championship_id', championshipId)
            .eq('user_id', username)
            .single();

        if (error) {
            // If no row is found, .single() returns an error
            if (error.code === 'PGRST116') { 
                return res.status(404).json({ error: 'Fantasy team not found' });
            }
            console.error('Error fetching fantasy team:', error);
            return res.status(500).json({ error: 'Internal server error' });
        }

        res.json(data);
    } catch (err) {
        console.error('Unexpected error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /championship/:championship_id/fantasy_teams
// Returns all fantasy teams for the given championship id.
router.get('/championship/:championship_id/fantasy_teams', authMiddleware, async (req, res) => {
    const championshipId = req.params.championship_id;
    
    try {
        const { data, error } = await db
            .from('fantasy_teams')
            .select(`id,
                    name,
                    user_id(id,email,first_name,last_name),
                    team_image,
                    official_rider_1(id,first_name,last_name,number),
                    official_rider_2(id,first_name,last_name,number),
                    reserve_rider(id,first_name,last_name,number)`)
            .eq('championship_id', championshipId);

        if (error) {
            console.error("Error fetching fantasy teams:", error);
            return res.status(500).json({ error: error.message });
        }

        res.json(data);
    } catch (err) {
        console.error("Unexpected error:", err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;

