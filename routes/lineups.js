// routes/lineups.js
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const authMiddleware = require('../middleware/authMiddleware');

/**
 * POST /api/championship/:championship_id/lineups
 * Inserts a new lineup record.
 * Expected body: { race_id, race_rider_id, qualifying_rider_id }
 */
router.post('/championship/:championship_id/lineups', authMiddleware, async (req, res) => {
  const championshipId = req.params.championship_id;
  const userId = req.userId; // attached by authMiddleware
  const { race_id, race_rider_id, qualifying_rider_id } = req.body;
  
  try {
    const { data, error } = await db
      .from('lineups')
      .insert([
        {
          championship_id: championshipId,
          race_id: race_id,
          user_id: userId,
          race_rider_id: race_rider_id,
          qualifying_rider_id: qualifying_rider_id
        }
      ]);
      
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
