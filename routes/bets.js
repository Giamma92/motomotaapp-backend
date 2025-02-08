const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const db = require('../models/db');

// GET all bets
router.get('/', authMiddleware, async (req, res) => {
    const { data, error } = await db.from('bets').select('*');
    if (error) return res.status(500).json({ error });
    res.json(data);
});

// ESubmit a bet
router.post('/', authMiddleware, async (req, res) => {
    const { user_id, race_id, position } = req.body;
    const { data, error } = await db
      .from('bets')
      .insert([{ user_id, race_id, position }]);
  
    if (error) return res.status(500).json({ error });
    res.json(data);
  });

  
module.exports = router;