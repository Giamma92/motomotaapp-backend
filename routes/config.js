const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const db = require('../models/db');

// GET configuration for a championship
router.get('/championship/:id/config', authMiddleware, async (req, res) => {
  const championshipId = req.params.id;
  try {
    const { data, error } = await db
      .from('configuration') 
      .select(`
        id,
        session_timeout,
        bets_limit_points,
        bets_limit_sprint_points,
        bets_limit_driver,
        bets_limit_sprint_driver,
        bets_limit_race,
        bets_limit_sprint_race,
        formation_limit_driver
      `)
      .eq('championship_id', championshipId)
      .single();  // Assuming one config per championship

    if (error) {
      console.error('Error fetching configuration:', error);
      return res.status(500).json({ error: error.message });
    }
    res.json(data);
  } catch (err) {
    console.error('Unexpected error fetching configuration:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST/UPDATE configuration
router.post('/championship/:id/config', authMiddleware, async (req, res) => {
  const championshipId = req.params.id;
  try {
    const { data, error } = await db
      .from('application_configuration')
      .upsert({
        ...req.body,
        championship_id: championshipId
      })
      .select();

    if (error) {
      console.error('Error saving configuration:', error);
      return res.status(500).json({ error: error.message });
    }
    res.json(data);
  } catch (err) {
    console.error('Unexpected error saving configuration:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router; 