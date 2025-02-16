// routes/lineups.js
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const authMiddleware = require('../middleware/authMiddleware');

/**
 * GET /api/championship/:championship_id/lineups/:race_id
 * Gets lineup data for a specific race and user
 */
router.get('/championship/:championship_id/lineups/:race_id', authMiddleware, async (req, res) => {
  const { championship_id, race_id } = req.params;
  const user_id = req.username;

  try {
    const { data, error } = await db
      .from('lineups')
      .select()
      .eq('championship_id', championship_id)
      .eq('user_id', user_id)
      .eq('calendar_id', race_id);

    if (error) {
      console.error("Error fetching lineup:", error);
      return res.status(500).json({ error: error.message });
    }
    
    if (data.length === 0) {
      return res.status(404).json({ error: "Lineup not found" });
    }

    res.status(200).json(data[0]);
  } catch (err) {
    console.error("Unexpected error in lineups endpoint:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * PUT /api/championship/:championship_id/lineups
 * Upserts a lineup record (insert or update if exists)
 * Expected body: { calendar_id, race_rider_id, qualifying_rider_id }
 */
router.put('/championship/:championship_id/lineups', authMiddleware, async (req, res) => {
  const championshipId = req.params.championship_id;
  const userId = req.username; // attached by authMiddleware
  const { calendar_id, race_rider_id, qualifying_rider_id } = req.body;
  
  try {
    const { data, error } = await db
      .from('lineups')
      .upsert({
          championship_id: championshipId,
          calendar_id: calendar_id,
          user_id: userId,
          race_rider_id: race_rider_id,
          qualifying_rider_id: qualifying_rider_id,
          modified_at: new Date().toISOString()
      }, { onConflict: 'championship_id, user_id, calendar_id' })
      .select();
      
    if (error) {
      console.error("Error inserting lineup:", error);
      return res.status(500).json({ error: error.message });
    }
    
    res.status(201).json(data[0]);
  } catch (err) {
    console.error("Unexpected error in lineups endpoint:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
