const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const db = require('../models/db');

// GET all standings of a specific championship
router.get('/championship/:id/standings', authMiddleware, async (req, res) => {
  const championshipId = req.params.id;  
  let { data: standings, error } = await db
      .from('standings')
      .select('*')
      .eq('championship_id', championshipId)
      .order('score', { ascending: false });
        
    if (error) return res.status(500).json({ error });
    res.json(standings);
});

// Submit a standing result
router.post('/standings', authMiddleware, async (req, res) => {
    const { user_id, race_id, position } = req.body;
    const { data, error } = await db
      .from('standings')
      .insert([{ user_id, championship_id, position, score }]);
  
    if (error) return res.status(500).json({ error });
    res.json(data);
  });

  
module.exports = router;