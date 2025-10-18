// routes/sprintBet.js
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const authMiddleware = require('../middleware/authMiddleware');


/**
 * PUT /api/championship/:championship_id/sprint_bet
 * Creates or updates a sprint bet.
 * Expected body: { calendar_id, rider_id, position, points }
 */
router.put('/championship/:championship_id/sprint_bet', authMiddleware, async (req, res) => {
  const { championship_id } = req.params;
  const user_id = req.username;
  let { position, points, rider_id, calendar_id } = req.body;

  // Ensure points is a positive integer (no zeros allowed)
  points = parseInt(points, 10);
  if (!Number.isInteger(points) || points < 1) {
    return res.status(400).json({ error: 'Points must be a positive integer.' });
  }

  try {
    // Load sprint-specific bet limits from your configuration table
    const { data: config, error: configError } = await db
      .from('configuration')
      .select('bets_limit_sprint_points, bets_limit_sprint_race, bets_limit_sprint_driver')
      .eq('championship_id', championship_id)
      .single();
    if (configError) {
      console.error('Error fetching configuration:', configError);
      return res.status(500).json({ error: configError.message });
    }

    // Fetch all sprint bets for this user and championship
    const { data: existingBets, error: betsError } = await db
      .from('sprint_bets')
      .select('calendar_id, rider_id, points')
      .eq('championship_id', championship_id)
      .eq('user_id', user_id);

    if (betsError) {
      console.error('Error fetching existing bets:', betsError);
      return res.status(500).json({ error: betsError.message });
    }

    // Calculate total points already used in sprint bets
    const totalPoints = existingBets.reduce((sum, b) => b.calendar_id === calendar_id ? sum + b.points : sum + 0);
    if (config.bets_limit_sprint_points && totalPoints + points > config.bets_limit_sprint_points) {
      return res.status(400).json({
        error: `Insufficient remaining points. You have ${config.bets_limit_sprint_points - totalPoints} points left.`
      });
    }

    // Check the number of sprint bets already placed on this race
    const betsThisRace = existingBets.filter(b => b.calendar_id === calendar_id);
    if (config.bets_limit_sprint_race && betsThisRace.length >= config.bets_limit_sprint_race) {
      return res.status(400).json({
        error: `Maximum number of sprint bets (${config.bets_limit_sprint_race}) reached for this race.`
      });
    }

    // Check the number of bets the user has placed on this rider
    const betsThisRider = existingBets.filter(b => b.rider_id === rider_id);
    if (config.bets_limit_sprint_driver && betsThisRider.length >= config.bets_limit_sprint_driver) {
      return res.status(400).json({
        error: `Maximum number of sprint bets (${config.bets_limit_sprint_driver}) reached for this rider.`
      });
    }

    // Everything checks out: upsert the sprint bet
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
      }, { onConflict: 'championship_id, user_id, calendar_id, rider_id' })
      .select();

    if (error) {
      console.error('Error upserting sprint bet:', error);
      return res.status(500).json({ error: error.message });
    }
    res.status(201).json(data[0]);
  } catch (err) {
    console.error('Unexpected error in sprint bet endpoint:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;


/**
 * GET /api/championship/:championship_id/sprint_bet
 * Retrieves a sprint bet for current user and calendar
 * Query params: calendar_id
 */
router.get('/championship/:championship_id/sprint_bet/:calendar_id', authMiddleware, async (req, res) => {
  const { championship_id, calendar_id } = req.params;
  const user_id = req.username;
  const allCalendar = req.query.allCalendar == 'true'
  
  try {
    let query = db
      .from('sprint_bets')
      .select()
      .eq('championship_id', championship_id)
      .eq('user_id', user_id);

      if (!allCalendar) {
        query = query.eq('calendar_id', calendar_id);
      }

      const { data, error } = await query.select();

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

/**
 * DELETE /api/championship/:championship_id/sprint_bet/:calendar_id/:rider_id
 * Deletes a sprint bet for current user and calendar
 * Query params: calendar_id, rider_id  
 */
router.delete('/championship/:championship_id/sprint_bet/:calendar_id/:rider_id',
  authMiddleware,
  async (req, res) => {
    const { championship_id, calendar_id, rider_id } = req.params;
    const user_id = req.username;
    const { error } = await db
      .from('sprint_bets')
      .delete()
      .eq('championship_id', championship_id)
      .eq('calendar_id', calendar_id)
      .eq('user_id', user_id)
      .eq('rider_id', rider_id);
    if (error) return res.status(500).json({ error: error.message });
    res.status(204).send();
});

module.exports = router;
