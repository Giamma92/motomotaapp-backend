const express = require('express');
const router = express.Router();
const db = require('../models/db'); // Your PostgreSQL connection pool
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt'); // Use bcrypt for password hashing

// POST /api/login
router.post('/login', async (req, res) => {
    console.log("New login request");
    const { username, password } = req.body;

    // Query the user by username
    let { data: user, error } = await db
        .from('users')
        .select("*")
        .eq('id', username)
        .single();

    if (error) return res.status(500).json({ error });
    
    if (!user) {
        console.log("No user found: " + username);
        return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Compare provided password with hashed password stored in the DB.
    // (If your passwords are stored in plain text—which is not recommended—skip bcrypt.compare.)
    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
        console.log("Invalid password for user: " + username);
        return res.status(401).json({ error: 'Invalid username or password' });
    }
    // Generate a JWT token; ensure you have a secret in your environment variables.
    const token = jwt.sign(
        { userId: user.profile_id, username: user.id },
        process.env.JWT_SECRET,
        { expiresIn: '1h' }
    );

    res.json({ token });

});

module.exports = router;
