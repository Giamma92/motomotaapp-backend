// routes/championship.js
const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const authorizeRoles = require('../middleware/authorizeRoles');
const db = require('../models/db');

/**
 * GET /championship/default
 * Returns the default championship for the current user
 * If the user has no championship_id, returns the championship with the highest year
 * If the user has a championship_id, returns the championship with the given id
 */
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


/**
 * GET /championships
 * Returns all championships.
 */
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

/**
 * POST /championships
 * Creates a new championship
 */
router.post('/championships', authMiddleware, authorizeRoles('Admin'), async (req, res) => {
  const { description, start_date, year } = req.body;
  try {
    const { data, error } = await db
      .from('championships')
      .insert({ description, start_date, year })
      .select();

    if (error) {
      return res.status(500).json({ error: error.message });
    }
    return res.status(201).json(data[0]);
  } catch (err) {
    console.error('Error creating championship:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /championships/:id
 * Updates a championship by id
 */
router.put('/championships/:id', authMiddleware, authorizeRoles('Admin'), async (req, res) => {
  const { id } = req.params;
  const { description, start_date, year } = req.body;
  try {
    const { data, error } = await db
      .from('championships')
      .update({ description, start_date, year })
      .eq('id', id)
      .select();

    if (error) {
      return res.status(500).json({ error: error.message });
    }
    return res.status(200).json(data[0]);
  } catch (err) {
    console.error('Error updating championship:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /championships/:id
 * Deletes a championship by id
 */
router.delete('/championships/:id', authMiddleware, authorizeRoles('Admin'), async (req, res) => {
  const { id } = req.params;
  try {
    const { error } = await db
      .from('championships')
      .delete()
      .eq('id', id);

    if (error) {
      return res.status(500).json({ error: error.message });
    }
    // Use 204 No Content to indicate success with no response body
    return res.status(204).send();
  } catch (err) {
    console.error('Error deleting championship:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});


module.exports = router;
