const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const db = require('../models/db');

// GET calendar of a specific championship
router.get('/championship/:id/calendar', authMiddleware, async (req, res) => {
    const championshipId = req.params.id;
    const { data, error } = await db.from('calendar').select('*').eq('championship_id', championshipId);
    if (error) return res.status(500).json({ error });
    res.json(data);
});

// GET calendar next-race of a specific championship
router.get('/championship/:id/next-race', authMiddleware, async (req, res) => {
  const now = new Date().toISOString().split('T')[0];
  const championshipId = req.params.id;
  const { data: calendar, error } = await db.from('calendar')
  .select('*')
  .eq('championship_id', championshipId)
  .gt('event_date', now)
  .order('event_date', { ascending: true });

  console.log("calendar", calendar);

  if (!calendar || calendar.length === 0) {
    return res.status(404).json({ error: 'No calendar found' });
  }

  var nextRace = calendar[0];

  //console.log("calendar", nextRace);

  if (error) return res.status(500).json({ error });
  res.json(nextRace);
});

// ESubmit a bet
router.post('/', authMiddleware, async (req, res) => {
    const { user_id, race_id, position } = req.body;
    const { data, error } = await db
      .from('races')
      .insert([{ user_id, race_id, position }]);
  
    if (error) return res.status(500).json({ error });
    res.json(data);
  });

  
module.exports = router;