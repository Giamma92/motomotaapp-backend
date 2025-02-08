const express = require('express');
const router = express.Router();
const db = require('../models/db');

// GET all riders (you might pre-populate this table)
router.get('/', async (req, res) => {
    const { data, error } = await db.from('riders').select('*');
    if (error) return res.status(500).json({ error });
    res.json(data);
});

// POST to create a new rider (if needed)
router.post('/', async (req, res) => {
  const { first_name, last_name } = req.body;
    const { data, error } = await db
        .from('riders')
        .insert([{ first_name, last_name }]);

    if (error) return res.status(500).json({ error });
    res.json(data);
});

module.exports = router;
