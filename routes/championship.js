// routes/championship.js
const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const db = require('../models/db');

// GET /championship/default
// Returns the championship for the current year.
router.get('/championship/default', authMiddleware, async (req, res) => {
  try {
    const currentYear = new Date().getFullYear();
    const { data, error } = await db
      .from('championships')
      .select('*')
      .eq('year', currentYear)
      .maybeSingle();

    if (error) {
      return res.status(500).json({ error: error.message });
    }
    if (!data) {
      return res.status(404).json({ error: 'Championship for current year not found' });
    }
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /championship
// Returns all championships.
router.get('/championships', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await db
      .from('championships')
      .select('*')
      .order('year', { ascending: false });
    if (error) {
      return res.status(500).json({ error: error.message });
    }
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
