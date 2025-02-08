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
        .select("profile_id,id,email,first_name,last_name,profile_image")
        .eq('profile_id', req.userId)
        .single();

    if (error) return res.status(500).json({ error });

    if (!userInfo) {
        return res.status(404).json({ error: 'User not found' });
    }
    res.json(userInfo);
});

module.exports = router;
