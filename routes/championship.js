// routes/championship.js
const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const db = require('../models/db');

router.get('/championship/default', authMiddleware, async (req, res) => {
  try {
    const username = req.username; // Assuming the authenticated user ID is available in req.user

    // Step 1: Fetch the user's championship_id from user_settings
    const { data: userSetting, error: userSettingError } = await db
      .from('user_settings')
      .select('championship_id')
      .eq('user_id', username)
      .maybeSingle();

    if (userSettingError) {
      return res.status(500).json({ error: userSettingError.message });
    }

    let championshipId = userSetting?.championship_id;
    let championship;

    if (championshipId) {
      // Step 2: Fetch championship by user's selected championship_id
      const { data, error } = await db
        .from('championships')
        .select('*')
        .eq('id', championshipId)
        .maybeSingle();

      if (error) {
        return res.status(500).json({ error: error.message });
      }
      championship = data;
    } else {
      // Step 3: Fetch the championship with the highest year
      const { data, error } = await db
        .from('championships')
        .select('*')
        .order('year', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        return res.status(500).json({ error: error.message });
      }
      championship = data;
    }

    if (!championship) {
      return res.status(404).json({ error: 'No championship found' });
    }

    res.json(championship);
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
