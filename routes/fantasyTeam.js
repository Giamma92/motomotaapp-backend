const express = require('express');
const router = express.Router();
const db = require('../models/db');
const authMiddleware = require('../middleware/authMiddleware');

// GET /championship/:championship_id/fantasy_team
// Returns the fantasy team for the logged‑in user filtered by championship_id
router.get('/championship/:championship_id/fantasy_team', authMiddleware, async (req, res) => {
    const championshipId = req.params.championship_id;
    const username = req.username; // Provided by authMiddleware

    console.log('Fetching fantasy team for user', username, 'in championship', championshipId);

    try {
        const { data, error } = await db
            .from('fantasy_teams')
            .select('name,team_image,official_rider_1(first_name,last_name),official_rider_2(first_name,last_name),reserve_rider(first_name,last_name)')
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

module.exports = router;

