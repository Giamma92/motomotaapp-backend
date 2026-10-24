const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const authorizeRoles = require('../middleware/authorizeRoles');
const { attachAliases } = require('../services/userMetaService');
const db = require('../models/db');

// GET /championship/:championship_id/standings
// Returns the standings filtered by championship_id
router.get('/championship/:championship_id/standings', authMiddleware, async (req, res) => {
  const championshipId = req.params.championship_id;
  const username = req.username; // Provided by authMiddleware

  try {
      const { data, error } = await db
          .from('standings')
          .select('id, user_id(id, first_name, last_name, profile_image), championship_id, position, score')
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

      await attachAliases(data, function(d) { return d && d.user_id ? d.user_id.id : null; });
      res.json(data);
  } catch (err) {
      console.error('Unexpected error:', err);
      res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/championship/:championship_id/standings-breakdown', authMiddleware, async (req, res) => {
  const championshipId = req.params.championship_id;

  try {
      const { data: entries, error } = await db
          .from('standings_entries')
          .select(`
            id,
            championship_id,
            calendar_id,
            user_id,
            qualifying_score,
            race_score,
            sprint_bet_score,
            sprint_bet_delta,
            race_bet_score,
            race_bet_delta,
            score,
            calculated_at
          `)
          .eq('championship_id', championshipId);

      if (error) {
          console.error('Error fetching standings breakdown:', error);
          return res.status(500).json({ error: 'Internal server error' });
      }

      if (!entries?.length) {
          return res.json([]);
      }

      const calendarIds = [...new Set(entries.map((entry) => Number(entry.calendar_id)).filter(Boolean))];
      const userIds = [...new Set(entries.map((entry) => entry.user_id).filter(Boolean))];

      const [
          { data: calendars, error: calendarsError },
          { data: users, error: usersError },
          { data: runs, error: runsError }
      ] = await Promise.all([
          db
              .from('calendar')
              .select(`
                id,
                race_order,
                event_date,
                cancelled,
                race_id(name,location,country)
              `)
              .in('id', calendarIds),
          db
              .from('users')
              .select('id, first_name, last_name, profile_image')
              .in('id', userIds),
          db
              .from('standings_runs')
              .select('calendar_id, status, source_hash')
              .eq('championship_id', championshipId)
              .in('calendar_id', calendarIds)
      ]);

      if (calendarsError) {
          console.error('Error fetching breakdown calendars:', calendarsError);
          return res.status(500).json({ error: 'Internal server error' });
      }

      if (usersError) {
          console.error('Error fetching breakdown users:', usersError);
          return res.status(500).json({ error: 'Internal server error' });
      }

      const calendarMap = new Map((calendars || []).map((calendar) => [Number(calendar.id), calendar]));
      const userMap = new Map((users || []).map((user) => [String(user.id), user]));
      const runMap = new Map((runs || []).map((run) => {
          const hashStr = String(run.source_hash || '');
          let stage = run.status || 'completed';
          if (hashStr.startsWith('partial_qualifying:')) {
              stage = 'partial_qualifying';
          } else if (hashStr.startsWith('partial_sprint:')) {
              stage = 'partial_sprint';
          } else if (hashStr.startsWith('completed:')) {
              stage = 'completed';
          }
          return [Number(run.calendar_id), stage];
      }));

      const hydrated = entries.map((entry) => ({
          ...entry,
          status: runMap.get(Number(entry.calendar_id)) || 'completed',
          calendar_id: { ...(calendarMap.get(Number(entry.calendar_id)) || {
              id: Number(entry.calendar_id) || entry.calendar_id,
              race_order: null,
              event_date: null,
              cancelled: false,
              race_id: { name: 'Gara', location: '', country: '' }
          }), status: runMap.get(Number(entry.calendar_id)) || 'completed' },
          user_id: userMap.get(String(entry.user_id)) || {
              id: String(entry.user_id),
              first_name: '',
              last_name: ''
          }
      }));

      const sorted = hydrated.sort((left, right) => {
          const leftRaceOrder = Number(left?.calendar_id?.race_order || 0);
          const rightRaceOrder = Number(right?.calendar_id?.race_order || 0);
          if (leftRaceOrder !== rightRaceOrder) {
              return leftRaceOrder - rightRaceOrder;
          }

          const scoreDelta = Number(right?.score || 0) - Number(left?.score || 0);
          if (scoreDelta !== 0) {
              return scoreDelta;
          }

          const leftName = `${left?.user_id?.first_name || ''} ${left?.user_id?.last_name || ''}`.trim();
          const rightName = `${right?.user_id?.first_name || ''} ${right?.user_id?.last_name || ''}`.trim();
          return leftName.localeCompare(rightName);
      });

      await attachAliases(sorted, function(s) { return s && s.user_id ? s.user_id.id : null; });
      res.json(sorted);
  } catch (err) {
      console.error('Unexpected error fetching standings breakdown:', err);
      res.status(500).json({ error: 'Internal server error' });
  }
});

// Submit a standing result
router.post('/standings', authMiddleware, authorizeRoles('Admin'), async (req, res) => {
    const { user_id, championship_id, position, score } = req.body;
    const { data, error } = await db
      .from('standings')
      .insert([{ user_id, championship_id, position, score }]);
  
    if (error) return res.status(500).json({ error });
    res.json(data);
});

  
module.exports = router;
