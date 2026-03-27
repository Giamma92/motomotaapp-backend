const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const db = require('../models/db');
const { DEFAULT_CHAMPIONSHIP_TIMEZONE, normalizeTimeZone } = require('../utils/championshipTime');

// GET configuration for a championship
router.get('/championship/:id/config', authMiddleware, async (req, res) => {
  const championshipId = req.params.id;
  try {
    const { data, error } = await db
      .from('configuration') 
      .select(`
        id,
        championship_id(description,start_date,year,is_active),
        session_timeout,
        bets_limit_points,
        bets_limit_sprint_points,
        bets_limit_driver,
        bets_limit_sprint_driver,
        bets_limit_race,
        bets_limit_sprint_race,
        formation_limit_driver,
        timezone
      `)
      .eq('championship_id', championshipId)
      .single();  // Assuming one config per championship

    if (error) {
      console.error('Error fetching configuration:', error);
      return res.status(500).json({ error: error.message });
    }
    res.json({
      ...data,
      timezone: normalizeTimeZone(data?.timezone || DEFAULT_CHAMPIONSHIP_TIMEZONE)
    });
  } catch (err) {
    console.error('Unexpected error fetching configuration:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST/UPDATE configuration
router.post('/championship/:id/config', authMiddleware, async (req, res) => {
  const championshipId = req.params.id;
  try {
    const payload = {
      ...req.body,
      championship_id: championshipId,
      timezone: normalizeTimeZone(req.body?.timezone || DEFAULT_CHAMPIONSHIP_TIMEZONE)
    };

    const { data, error } = await db
      .from('configuration')
      .upsert(payload, { onConflict: 'championship_id' })
      .select()
      .maybeSingle();

    if (error) {
      console.error('Error saving configuration:', error);
      return res.status(500).json({ error: error.message });
    }
    res.json({
      ...data,
      timezone: normalizeTimeZone(data?.timezone || payload.timezone)
    });
  } catch (err) {
    console.error('Unexpected error saving configuration:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router; 
