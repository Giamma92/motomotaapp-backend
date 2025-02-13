const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const db = require('../models/db');

// GET /championship/:championship_id/standings
// Returns the standings filtered by championship_id
router.get('/championship/:championship_id/standings', authMiddleware, async (req, res) => {
  const championshipId = req.params.championship_id;
  const username = req.username; // Provided by authMiddleware

  console.log('Fetching fantasy team for user', username, 'in championship', championshipId);

  try {
      const { data, error } = await db
          .from('standings')
          .select('*')
          .eq('championship_id', championshipId)
          .order('score', { ascending: false });

      if (error) {
          // If no row is found, .single() returns an error
          if (error.code === 'PGRST116') { 
              return res.status(404).json({ error: 'Standings not found' });
          }
          console.error('Error fetching standings:', error);
          return res.status(500).json({ error: 'Internal server error' });
      }

      res.json(data);
  } catch (err) {
      console.error('Unexpected error:', err);
      res.status(500).json({ error: 'Internal server error' });
  }
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