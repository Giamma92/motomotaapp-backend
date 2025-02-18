const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const db = require('../models/db');

// GET all riders (you might pre-populate this table)
router.get('/riders', authMiddleware, async (req, res) => {
    const { data, error } = await db.from('riders').select('*');
    if (error) return res.status(500).json({ error });
    res.json(data);
});

// POST to create a new rider (if needed)
router.post('/riders', authMiddleware, async (req, res) => {
  const { first_name, last_name } = req.body;
    const { data, error } = await db
        .from('riders')
        .insert([{ first_name, last_name }]);

    if (error) return res.status(500).json({ error });
    res.json(data);
});

// GET riders with constructors for a specific championship
router.get('/championship/:id/riders', authMiddleware, async (req, res) => {
  const championshipId = req.params.id;
  try {
    const { data, error } = await db
      .from('championship_riders')
      .select(`
        id,
        rider_id(
          first_name,
          last_name,
          number
        ),
        constructor_id(
          name,
          nationality
        )
      `)
      .eq('championship_id', championshipId);
    if (error) {
      console.error('Error fetching championship riders:', error);
      return res.status(500).json({ error: error.message });
    }
    res.json(data);
  } catch (err) {
    console.error('Unexpected error fetching riders:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
