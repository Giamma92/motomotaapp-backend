const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const db = require('../models/db');

// GET /api/user-info
router.get('/user-info', authMiddleware, async (req, res) => {

    console.log("New user info request");

    // Query the user by username
    let { data: userInfo, error } = await db
        .from('users')
        .select("id,password,profile_id,profile_image,first_name,last_name,last_access,email,pwd_reset")
        .eq('profile_id', req.userId)
        .single();

    if (error) return res.status(500).json({ error });

    if (!userInfo) {
        return res.status(404).json({ error: 'User not found' });
    }
    res.json(userInfo);
});

// PUT /api/user/password
router.put('/user/password', authMiddleware, async (req, res) => {
    const { password } = req.body;

    if (!password || typeof password !== 'string') {
        return res.status(400).json({ error: 'Missing or invalid password' });
    }

    try {
        // Update by username from JWT (req.username)
        const { data, error } = await db
            .from('users')
            .update({ password, pwd_reset: 0 })
            .eq('id', req.username)
            .select('id');

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        if (!data || data.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
