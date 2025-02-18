// routes/sprintBet.js
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const authMiddleware = require('../middleware/authMiddleware');

/**
 * POST /api/championship/:championship_id/sprint_bet
 * Inserts a new sprint bet.
 * Expected body: { calendar_id, rider_id, position, points, outcome }
 */
router.put('/championship/:championship_id/sprint_bet', authMiddleware, async (req, res) => {
  const { championship_id } = req.params;
  const user_id = req.username;
  const { position, points, rider_id, calendar_id } = req.body;
  
  try {
    const { data, error } = await db
      .from('sprint_bets')
      .upsert({
          championship_id: championship_id,
          calendar_id: calendar_id,
          user_id: user_id,
          rider_id: rider_id,
          position: position,
          points: points,
          modified_at: new Date().toISOString()
      }, { onConflict: 'championship_id, user_id, calendar_id' })
      .select();

    if (error) {
      console.error("Error upserting sprint bet:", error);
      return res.status(500).json({ error: error.message });
    }
    
    res.status(201).json(data[0]);
  } catch (err) {
    console.error("Unexpected error in sprint bet endpoint:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/championship/:championship_id/sprint_bet
 * Retrieves a sprint bet for current user and calendar
 * Query params: calendar_id
 */
router.get('/championship/:championship_id/sprint_bet/:calendar_id', authMiddleware, async (req, res) => {
  const { championship_id, calendar_id } = req.params;
  const user_id = req.username;

  try {
    const { data, error } = await db
      .from('sprint_bets')
      .select()
      .eq('championship_id', championship_id)
      .eq('user_id', user_id)
      .eq('calendar_id', calendar_id)
      .single();

    if (error) {
      if (error.message.includes('No rows found')) {
        return res.status(404).json({ error: 'Sprint bet not found' });
      }
      console.error("Error fetching sprint bet:", error);
      return res.status(500).json({ error: error.message });
    }
    
    res.status(200).json(data);
  } catch (err) {
    console.error("Unexpected error in sprint bet fetch:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
