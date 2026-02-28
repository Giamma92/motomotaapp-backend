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
router.put('/championship/:championship_id/race_bet', authMiddleware, async (req, res) => {
  const { championship_id } = req.params;
  const user_id = req.username;
  let { position, points, rider_id, calendar_id } = req.body;

  calendar_id = Number(calendar_id);
  rider_id = Number(rider_id);
  position = Number(position);

  if (!Number.isInteger(calendar_id) || !Number.isInteger(rider_id) || !Number.isInteger(position)) {
    return res.status(400).json({ error: 'calendar_id, rider_id and position must be integers.' });
  }

  // Ensure points is a positive integer
  points = parseInt(points, 10);
  if (!Number.isInteger(points) || points < 1) {
    return res.status(400).json({ error: 'Points must be a positive integer.' });
  }

  try {
    // Check lineup to disallow betting on your race rider
    const { data: lineup, error: lineupError } = await db
      .from('lineups')
      .select('race_rider_id')
      .eq('championship_id', championship_id)
      .eq('user_id', user_id)
      .eq('calendar_id', calendar_id)
      .maybeSingle();
    if (lineupError) return res.status(500).json({ error: lineupError.message });
    if (lineup && Number(lineup.race_rider_id) === rider_id) {
      return res.status(400).json({ error: 'Cannot bet on your current race rider.' });
    }

    // Get configuration values
    const { data: config, error: configError } = await db
      .from('configuration')
      .select('bets_limit_points, bets_limit_driver, bets_limit_race')
      .eq('championship_id', championship_id)
      .single();
    if (configError) return res.status(500).json({ error: configError.message });

    // Load existing bets for user/championship
    const { data: existingBets, error: betsError } = await db
      .from('race_bets')
      .select('calendar_id, rider_id, points')
      .eq('championship_id', championship_id)
      .eq('user_id', user_id);
    if (betsError) return res.status(500).json({ error: betsError.message });

    const bets = existingBets || [];

    // Points cap
    const totalPoints = bets.reduce(
      (sum, bet) => (Number(bet.calendar_id) === calendar_id ? sum + Number(bet.points || 0) : sum),
      0
    );
    if (config.bets_limit_points && totalPoints + points > config.bets_limit_points) {
      return res.status(400).json({ error: 'Insufficient remaining points.' });
    }

    // Max bets per race
    const betsThisRace = bets.filter(bet => Number(bet.calendar_id) === calendar_id);
    if (config.bets_limit_race && betsThisRace.length >= config.bets_limit_race) {
      return res.status(400).json({ error: 'Maximum bets reached for this race.' });
    }

    // Max bets per rider
    const betsThisRider = bets.filter(bet => Number(bet.rider_id) === rider_id);
    if (config.bets_limit_driver && betsThisRider.length >= config.bets_limit_driver) {
      return res.status(400).json({ error: 'Maximum bets reached for this rider.' });
    }

    // If everything is valid, proceed with upsert
    const { data, error } = await db
      .from('race_bets')
      .upsert({ championship_id, calendar_id, user_id, rider_id, position, points, modified_at: new Date().toISOString() }, { onConflict: 'championship_id, user_id, calendar_id, rider_id' })
      .select();
    if (error) return res.status(500).json({ error: error.message });

    res.status(201).json(data[0]);
  } catch (err) {
    console.error('Unexpected error in race bet endpoint:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});


/**
 * GET /api/championship/:championship_id/race_bet
 * Retrieves a sprint bet for current user and calendar
 * Query params: calendar_id
 */
router.get('/championship/:championship_id/race_bet/:calendar_id', authMiddleware, async (req, res) => {
  const { championship_id, calendar_id } = req.params;
  const user_id = req.username;
  const allCalendar = req.query.allCalendar == 'true'

  try {
    let query = db
      .from('race_bets')
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
 * DELETE /api/championship/:championship_id/race_bet/:calendar_id/:rider_id
 * Deletes a race bet for current user and calendar
 * Query params: calendar_id, rider_id
 */
router.delete('/championship/:championship_id/race_bet/:calendar_id/:rider_id',
  authMiddleware,
  async (req, res) => {
    const { championship_id, calendar_id, rider_id } = req.params;
    const user_id = req.username;
    const { error } = await db
      .from('race_bets')
      .delete()
      .eq('championship_id', championship_id)
      .eq('calendar_id', calendar_id)
      .eq('user_id', user_id)
      .eq('rider_id', rider_id);
    if (error) return res.status(500).json({ error: error.message });
    res.status(204).send();
});

module.exports = router;
