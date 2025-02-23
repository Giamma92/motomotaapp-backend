const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const db = require('../models/db');

// GET calendar of a specific championship
router.get('/championship/:id/calendar', authMiddleware, async (req, res) => {
  const championshipId = req.params.id;
  try {
    const { data, error } = await db
      .from('calendar')
      .select(`
        id,
        race_order,
        event_date,
        qualifications_time,
        sprint_time,
        event_time,
        race_id(name,location)
      `)
      .eq('championship_id', championshipId)
      .order('race_order', { ascending: true });

    if (error) {
      console.error('Error fetching calendar:', error);
      return res.status(500).json({ error: error.message });
    }
    res.json(data);
  } catch (err) {
    console.error('Unexpected error fetching calendar:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET a specific calendar row for a championship
router.get('/championship/:championship_id/calendar/:calendar_id', authMiddleware, async (req, res) => {
  const championshipId = req.params.championship_id;
  const calendarId = req.params.calendar_id;
  try {
    const { data, error } = await db
      .from('calendar')
      .select(`
        id,
        race_order,
        event_date,
        qualifications_time,
        sprint_time,
        event_time,
        race_id(name,location,country)
      `)
      .eq('championship_id', championshipId)
      .eq('id', calendarId)
      .single();

    if (error) {
      console.error('Error fetching calendar row:', error);
      return res.status(500).json({ error: error.message });
    }
    res.json(data);
  } catch (err) {
    console.error('Unexpected error fetching calendar row:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});


/**
 * GET /api/championship/:championship_id/next-race
 * Returns the next race for the championship.
 * Now uses gte condition so that if today's event exists, it is returned.
 */
router.get('/championship/:championship_id/next-race', authMiddleware, async (req, res) => {
  const championshipId = req.params.championship_id;
  try {
    // Get today's date as "YYYY-MM-DD"
    const today = new Date().toISOString().split('T')[0];

    // Query for races where event_date is greater than or equal to today
    const { data, error } = await db
      .from('calendar')
      .select(`
        id,
        race_order,
        event_date,
        qualifications_time,
        sprint_time,
        event_time,
        race_id(name,location,country`)
      .eq('championship_id', championshipId)
      .gte('event_date', today)
      .order('event_date', { ascending: true })
      .limit(1);

    if (error) {
      console.error('Error fetching next race:', error);
      return res.status(500).json({ error: error.message });
    }
    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'No upcoming race found' });
    }
    res.json(data[0]);
  } catch (err) {
    console.error('Unexpected error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;