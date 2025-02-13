// routes/sprintBet.js
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const authMiddleware = require('../middleware/authMiddleware');

/**
 * POST /api/championship/:championship_id/sprint_bet
 * Inserts a new sprint bet.
 * Expected body: { race_id, rider_id, position, points, outcome }
 */
router.post('/championship/:championship_id/sprint_bet', authMiddleware, async (req, res) => {
  const championshipId = req.params.championship_id;
  const userId = req.userId;
  const { race_id, rider_id, position, points, outcome } = req.body;
  
  try {
    const { data, error } = await db
      .from('sprint_bets')
      .insert([
        {
          championship_id: championshipId,
          race_id: race_id,
          user_id: userId,
          rider_id: rider_id,
          position: position,
          points: points,
          outcome: outcome
        }
      ]);
    
    if (error) {
      console.error("Error inserting sprint bet:", error);
      return res.status(500).json({ error: error.message });
    }
    
    res.status(201).json(data[0]);
  } catch (err) {
    console.error("Unexpected error in sprint bet endpoint:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
