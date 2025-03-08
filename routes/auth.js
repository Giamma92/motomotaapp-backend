const express = require('express');
const router = express.Router();
const db = require('../models/db'); // Your PostgreSQL connection pool
const jwt = require('jsonwebtoken');

// POST /api/login
router.post('/login', async (req, res) => {
    console.log("New login request");
    const { username, password: clientHashedPassword } = req.body;

    try {
        // 🔹 Query the user by username
        let { data: user, error } = await db
            .from('users')
            .select('*')
            .eq('id', username)
            .single();

        if (error) return res.status(500).json({ error: error.message });

        if (!user) {
            console.log("No user found: " + username);
            return res.status(401).json({ error: 'Invalid username or password' });
        }

        // 🔹 Compare the received hashed password with the stored hash
        if (clientHashedPassword !== user.password) {
            console.log("Invalid password for user: " + username);
            return res.status(401).json({ error: 'Invalid username or password' });
        }

        // 🔹 Fetch user roles
        const { data: roles, error: rolesError } = await db
            .from('user_roles')
            .select('user_id, role_id(id, description)')
            .eq('user_id', username);

        if (rolesError) {
            console.error("Error fetching user roles:", rolesError);
            return res.status(500).json({ error: 'Failed to fetch user roles' });
        }

        // 🔹 Update last_access timestamp
        const { error: updateError } = await db
            .from('users')
            .update({ last_access: new Date().toISOString() })
            .eq('id', username);

        if (updateError) {
            console.error("Error updating last_access:", updateError);
            return res.status(500).json({ error: 'Failed to update last_access' });
        }

        console.log(`Updated last_access for user: ${username}`);

        // 🔹 Generate a JWT token
        const token = jwt.sign(
            {
                userId: user.profile_id,
                username: user.id,
                email: user.email,
                firstName: user.first_name,
                lastName: user.last_name,
                roles: roles.map(r => r.role_id.description)
            },
            process.env.JWT_SECRET,
            { expiresIn: '1h' }
        );

        res.json({ token });

    } catch (err) {
        console.error("Login error:", err);
        res.status(500).json({ error: 'Internal server error' });
    }
});


module.exports = router;
