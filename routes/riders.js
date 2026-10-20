const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const authorizeRoles = require('../middleware/authorizeRoles');
const db = require('../models/db');

// ==========================================
// RIDERS MASTER DATA
// ==========================================

// GET all riders
router.get('/riders', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await db
      .from('riders')
      .select('*')
      .order('number', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST create new rider
router.post('/riders', authMiddleware, authorizeRoles('Admin'), async (req, res) => {
  const { first_name, last_name, number } = req.body;
  if (!first_name || !last_name || number == null) {
    return res.status(400).json({ error: 'first_name, last_name, and number are required.' });
  }

  try {
    const { data, error } = await db
      .from('riders')
      .insert([{
        first_name: first_name.trim(),
        last_name: last_name.trim(),
        number: Number(number)
      }])
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT update rider
router.put('/riders/:id', authMiddleware, authorizeRoles('Admin'), async (req, res) => {
  const { id } = req.params;
  const { first_name, last_name, number } = req.body;

  try {
    const updates = {};
    if (first_name !== undefined) updates.first_name = first_name.trim();
    if (last_name !== undefined) updates.last_name = last_name.trim();
    if (number !== undefined) updates.number = Number(number);

    const { data, error } = await db
      .from('riders')
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

// DELETE rider
router.delete('/riders/:id', authMiddleware, authorizeRoles('Admin'), async (req, res) => {
  const { id } = req.params;
  try {
    const { error } = await db
      .from('riders')
      .delete()
      .eq('id', id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, message: 'Rider deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// CONSTRUCTORS MASTER DATA
// ==========================================

// GET all constructors
router.get('/constructors', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await db
      .from('constructors')
      .select('*')
      .order('name', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST create constructor
router.post('/constructors', authMiddleware, authorizeRoles('Admin'), async (req, res) => {
  const { name, nationality } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'name is required.' });
  }

  try {
    const { data, error } = await db
      .from('constructors')
      .insert([{
        name: name.trim(),
        nationality: nationality ? nationality.trim() : null
      }])
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT update constructor
router.put('/constructors/:id', authMiddleware, authorizeRoles('Admin'), async (req, res) => {
  const { id } = req.params;
  const { name, nationality } = req.body;

  try {
    const updates = {};
    if (name !== undefined) updates.name = name.trim();
    if (nationality !== undefined) updates.nationality = nationality ? nationality.trim() : null;

    const { data, error } = await db
      .from('constructors')
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

// DELETE constructor
router.delete('/constructors/:id', authMiddleware, authorizeRoles('Admin'), async (req, res) => {
  const { id } = req.params;
  try {
    const { error } = await db
      .from('constructors')
      .delete()
      .eq('id', id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, message: 'Constructor deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// CHAMPIONSHIP RIDERS ASSOCIATIONS
// ==========================================

// GET riders with constructors for a specific championship
router.get('/championship/:id/riders', authMiddleware, async (req, res) => {
  const championshipId = req.params.id;
  try {
    const { data, error } = await db
      .from('championship_riders')
      .select(`
        id,
        championship_id,
        rider_id(
          id,
          first_name,
          last_name,
          number
        ),
        constructor_id(
          id,
          name,
          nationality
        )
      `)
      .eq('championship_id', championshipId)
      .order('id', { ascending: true });

    if (error) {
      console.error('Error fetching championship riders:', error);
      return res.status(500).json({ error: error.message });
    }
    res.json(data);
  } catch (err) {
    console.error('Unexpected error fetching riders:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST associate rider and constructor to championship
router.post('/championship/:id/riders', authMiddleware, authorizeRoles('Admin'), async (req, res) => {
  const championshipId = Number(req.params.id);
  const { rider_id, constructor_id } = req.body;

  if (!rider_id || !constructor_id) {
    return res.status(400).json({ error: 'rider_id and constructor_id are required' });
  }

  try {
    // Check if rider already associated in this championship
    const { data: existing } = await db
      .from('championship_riders')
      .select('id')
      .eq('championship_id', championshipId)
      .eq('rider_id', rider_id)
      .maybeSingle();

    if (existing) {
      return res.status(409).json({ error: 'Rider is already assigned to this championship.' });
    }

    const { data, error } = await db
      .from('championship_riders')
      .insert([{
        championship_id: championshipId,
        rider_id: Number(rider_id),
        constructor_id: Number(constructor_id)
      }])
      .select(`
        id,
        championship_id,
        rider_id(id, first_name, last_name, number),
        constructor_id(id, name, nationality)
      `)
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT update championship rider association
router.put('/championship/:id/riders/:assoc_id', authMiddleware, authorizeRoles('Admin'), async (req, res) => {
  const { assoc_id } = req.params;
  const { rider_id, constructor_id } = req.body;

  try {
    const updates = {};
    if (rider_id !== undefined) updates.rider_id = Number(rider_id);
    if (constructor_id !== undefined) updates.constructor_id = Number(constructor_id);

    const { data, error } = await db
      .from('championship_riders')
      .update(updates)
      .eq('id', assoc_id)
      .select(`
        id,
        championship_id,
        rider_id(id, first_name, last_name, number),
        constructor_id(id, name, nationality)
      `)
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE remove rider from championship
router.delete('/championship/:id/riders/:assoc_id', authMiddleware, authorizeRoles('Admin'), async (req, res) => {
  const { assoc_id } = req.params;
  try {
    const { error } = await db
      .from('championship_riders')
      .delete()
      .eq('id', assoc_id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, message: 'Rider removed from championship' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
