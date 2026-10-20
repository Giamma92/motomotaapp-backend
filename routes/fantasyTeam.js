const express = require('express');
const router = express.Router();
const db = require('../models/db');
const authMiddleware = require('../middleware/authMiddleware');
const authorizeRoles = require('../middleware/authorizeRoles');

// GET /championship/:championship_id/fantasy_team
// Returns the fantasy team for the logged‑in user filtered by championship_id
router.get('/championship/:championship_id/fantasy_team', authMiddleware, async (req, res) => {
  const championshipId = req.params.championship_id;
  const username = req.username; // Provided by authMiddleware

  try {
    const { data, error } = await db
      .from('fantasy_teams')
      .select(`id,
              name,
              team_image,
              official_rider_1(id,first_name,last_name,number),
              official_rider_2(id,first_name,last_name,number),
              reserve_rider(id,first_name,last_name,number)`)
      .eq('championship_id', championshipId)
      .eq('user_id', username)
      .single();

    if (error) {
      if (error.code === 'PGRST116') { 
        return res.status(404).json({ error: 'Fantasy team not found' });
      }
      console.error('Error fetching fantasy team:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }

    res.json(data);
  } catch (err) {
    console.error('Unexpected error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /championship/:championship_id/fantasy_teams
// Returns all fantasy teams for the given championship id.
router.get('/championship/:championship_id/fantasy_teams', authMiddleware, async (req, res) => {
  const championshipId = req.params.championship_id;
  
  try {
    const { data, error } = await db
      .from('fantasy_teams')
      .select(`id,
              name,
              user_id(id,email,first_name,last_name),
              team_image,
              official_rider_1(id,first_name,last_name,number),
              official_rider_2(id,first_name,last_name,number),
              reserve_rider(id,first_name,last_name,number)`)
      .eq('championship_id', championshipId);

    if (error) {
      console.error("Error fetching fantasy teams:", error);
      return res.status(500).json({ error: error.message });
    }

    res.json(data);
  } catch (err) {
    console.error("Unexpected error:", err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /championship/:championship_id/fantasy_teams
// (Admin) Create a new fantasy team
router.post('/championship/:championship_id/fantasy_teams', authMiddleware, authorizeRoles('Admin'), async (req, res) => {
  const championshipId = Number(req.params.championship_id);
  const { name, user_id, official_rider_1, official_rider_2, reserve_rider, team_image } = req.body;

  if (!name || !user_id) {
    return res.status(400).json({ error: 'name and user_id are required' });
  }

  try {
    const insertData = {
      championship_id: championshipId,
      name: name.trim(),
      user_id: user_id.trim(),
      official_rider_1: official_rider_1 ? Number(official_rider_1) : null,
      official_rider_2: official_rider_2 ? Number(official_rider_2) : null,
      reserve_rider: reserve_rider ? Number(reserve_rider) : null,
      team_image: team_image || 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcRsizsv8wy9b4n55DyT1GQGE7QPo8xXqhUjeQ&s'
    };

    const { data, error } = await db
      .from('fantasy_teams')
      .insert([insertData])
      .select(`
        id,
        name,
        user_id(id, email, first_name, last_name),
        team_image,
        official_rider_1(id, first_name, last_name, number),
        official_rider_2(id, first_name, last_name, number),
        reserve_rider(id, first_name, last_name, number)
      `)
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /championship/:championship_id/fantasy_teams/:team_id
// (Admin) Update a fantasy team and rider assignments
router.put('/championship/:championship_id/fantasy_teams/:team_id', authMiddleware, authorizeRoles('Admin'), async (req, res) => {
  const championshipId = Number(req.params.championship_id);
  const teamId = Number(req.params.team_id);
  const { name, user_id, official_rider_1, official_rider_2, reserve_rider, team_image } = req.body;

  try {
    const updates = {};
    if (name !== undefined) updates.name = name.trim();
    if (user_id !== undefined) updates.user_id = user_id.trim();
    if (official_rider_1 !== undefined) updates.official_rider_1 = official_rider_1 ? Number(official_rider_1) : null;
    if (official_rider_2 !== undefined) updates.official_rider_2 = official_rider_2 ? Number(official_rider_2) : null;
    if (reserve_rider !== undefined) updates.reserve_rider = reserve_rider ? Number(reserve_rider) : null;
    if (team_image !== undefined) updates.team_image = team_image;

    const { data, error } = await db
      .from('fantasy_teams')
      .update(updates)
      .eq('championship_id', championshipId)
      .eq('id', teamId)
      .select(`
        id,
        name,
        user_id(id, email, first_name, last_name),
        team_image,
        official_rider_1(id, first_name, last_name, number),
        official_rider_2(id, first_name, last_name, number),
        reserve_rider(id, first_name, last_name, number)
      `)
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /championship/:championship_id/fantasy_teams/:team_id
// (Admin) Delete a fantasy team
router.delete('/championship/:championship_id/fantasy_teams/:team_id', authMiddleware, authorizeRoles('Admin'), async (req, res) => {
  const championshipId = Number(req.params.championship_id);
  const teamId = Number(req.params.team_id);

  try {
    const { error } = await db
      .from('fantasy_teams')
      .delete()
      .eq('championship_id', championshipId)
      .eq('id', teamId);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, message: 'Fantasy team deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /users
// (Admin) List all users to populate owner dropdown
router.get('/users', authMiddleware, authorizeRoles('Admin'), async (req, res) => {
  try {
    const { data, error } = await db
      .from('users')
      .select('id, email, first_name, last_name, profile_id')
      .order('first_name', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
