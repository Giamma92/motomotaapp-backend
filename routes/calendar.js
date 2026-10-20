const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const authorizeRoles = require('../middleware/authorizeRoles');
const db = require('../models/db');
const { notifyChampionshipUsers } = require('../services/notificationService');
const {
  DEFAULT_CHAMPIONSHIP_TIMEZONE,
  formatYyyyMmDd,
  normalizeTimeZone
} = require('../utils/championshipTime');

async function loadChampionshipTimezone(championshipId) {
  const { data, error } = await db
    .from('configuration')
    .select('timezone')
    .eq('championship_id', championshipId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return normalizeTimeZone(data?.timezone || DEFAULT_CHAMPIONSHIP_TIMEZONE);
}

// ==========================================
// RACES MASTER DATA (Circuits / Grand Prix)
// ==========================================

// GET all master races
router.get('/races', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await db
      .from('races')
      .select('*')
      .order('name', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST create race
router.post('/races', authMiddleware, authorizeRoles('Admin'), async (req, res) => {
  const { name, location, country } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  try {
    const { data, error } = await db
      .from('races')
      .insert([{
        name: name.trim(),
        location: location ? location.trim() : null,
        country: country ? country.trim().toLowerCase() : null
      }])
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT update race
router.put('/races/:id', authMiddleware, authorizeRoles('Admin'), async (req, res) => {
  const { id } = req.params;
  const { name, location, country } = req.body;

  try {
    const updates = {};
    if (name !== undefined) updates.name = name.trim();
    if (location !== undefined) updates.location = location ? location.trim() : null;
    if (country !== undefined) updates.country = country ? country.trim().toLowerCase() : null;

    const { data, error } = await db
      .from('races')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE race
router.delete('/races/:id', authMiddleware, authorizeRoles('Admin'), async (req, res) => {
  const { id } = req.params;
  try {
    const { error } = await db
      .from('races')
      .delete()
      .eq('id', id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, message: 'Race deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// CALENDAR (Championship Races)
// ==========================================

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
        cancelled,
        race_id(id, name, location, country)
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
        championship_id,
        race_order,
        event_date,
        qualifications_time,
        sprint_time,
        event_time,
        cancelled,
        race_id(id, name, location, country)
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

// POST add race to championship calendar
router.post('/championship/:championship_id/calendar', authMiddleware, authorizeRoles('Admin'), async (req, res) => {
  const championshipId = Number(req.params.championship_id);
  const { race_id, race_order, event_date, qualifications_time, sprint_time, event_time, cancelled } = req.body;

  if (!race_id || !event_date || race_order == null) {
    return res.status(400).json({ error: 'race_id, race_order and event_date are required' });
  }

  try {
    const { data, error } = await db
      .from('calendar')
      .insert([{
        championship_id: championshipId,
        race_id: Number(race_id),
        race_order: Number(race_order),
        event_date,
        qualifications_time: qualifications_time || '10:50:00',
        sprint_time: sprint_time || '15:00:00',
        event_time: event_time || '14:00:00',
        cancelled: Boolean(cancelled)
      }])
      .select(`
        id,
        championship_id,
        race_order,
        event_date,
        qualifications_time,
        sprint_time,
        event_time,
        cancelled,
        race_id(id, name, location, country)
      `)
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT update calendar race
router.put('/championship/:championship_id/calendar/:calendar_id', authMiddleware, authorizeRoles('Admin'), async (req, res) => {
  const championshipId = Number(req.params.championship_id);
  const calendarId = Number(req.params.calendar_id);
  const { race_id, race_order, event_date, qualifications_time, sprint_time, event_time, cancelled } = req.body;

  try {
    const updates = {};
    if (race_id !== undefined) updates.race_id = Number(race_id);
    if (race_order !== undefined) updates.race_order = Number(race_order);
    if (event_date !== undefined) updates.event_date = event_date;
    if (qualifications_time !== undefined) updates.qualifications_time = qualifications_time;
    if (sprint_time !== undefined) updates.sprint_time = sprint_time;
    if (event_time !== undefined) updates.event_time = event_time;
    if (cancelled !== undefined) updates.cancelled = Boolean(cancelled);

    const { data, error } = await db
      .from('calendar')
      .update(updates)
      .eq('championship_id', championshipId)
      .eq('id', calendarId)
      .select(`
        id,
        championship_id,
        race_order,
        event_date,
        qualifications_time,
        sprint_time,
        event_time,
        cancelled,
        race_id(id, name, location, country)
      `)
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE race from calendar
router.delete('/championship/:championship_id/calendar/:calendar_id', authMiddleware, authorizeRoles('Admin'), async (req, res) => {
  const championshipId = Number(req.params.championship_id);
  const calendarId = Number(req.params.calendar_id);

  try {
    const { error } = await db
      .from('calendar')
      .delete()
      .eq('championship_id', championshipId)
      .eq('id', calendarId);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, message: 'Calendar race deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/championship/:championship_id/next-race
 */
router.get('/championship/:championship_id/next-race', authMiddleware, async (req, res) => {
  const championshipId = req.params.championship_id;
  try {
    const championshipTimeZone = await loadChampionshipTimezone(championshipId);
    const today = formatYyyyMmDd(new Date(), championshipTimeZone);

    const { data, error } = await db
      .from('calendar')
      .select(`
        id,
        race_order,
        event_date,
        qualifications_time,
        sprint_time,
        event_time,
        cancelled,
        race_id(id, name, location, country)`)
      .eq('championship_id', championshipId)
      .eq('cancelled', false)
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

// PATCH cancellation status for a specific calendar race
router.patch('/championship/:championship_id/calendar/:calendar_id/cancelled', authMiddleware, authorizeRoles('Admin'), async (req, res) => {
  const championshipId = req.params.championship_id;
  const calendarId = req.params.calendar_id;
  const cancelled = Boolean(req.body?.cancelled);

  try {
    const { data, error } = await db
      .from('calendar')
      .update({ cancelled })
      .eq('championship_id', championshipId)
      .eq('id', calendarId)
      .select(`
        id,
        championship_id,
        race_order,
        event_date,
        qualifications_time,
        sprint_time,
        event_time,
        cancelled,
        race_id(name,location,country)
      `)
      .single();

    if (error) {
      console.error('Error updating calendar cancellation status:', error);
      return res.status(500).json({ error: error.message });
    }

    if (cancelled) {
      const raceName = data?.race_id?.name || `Gara ${calendarId}`;
      await notifyChampionshipUsers({
        championshipId: Number(championshipId),
        excludeUserId: null,
        category: 'race_cancelled',
        title: `Gara cancellata: ${raceName}`,
        body: `La gara ${raceName} è stata cancellata. Schieramenti e scommesse non saranno considerati.`,
        type: 'warning',
        link: `/race-detail/${calendarId}`
      }).catch(err => console.error('Failed to send race cancelled notification:', err));
    }

    res.json(data);
  } catch (err) {
    console.error('Unexpected error updating calendar cancellation status:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
