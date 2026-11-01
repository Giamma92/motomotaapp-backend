const express = require('express');
const router = express.Router();
const db = require('../models/db'); // Your PostgreSQL connection pool
const jwt = require('jsonwebtoken');
const authMiddleware = require('../middleware/authMiddleware');
const { createNotification } = require('../services/notificationService');
const { sendPushToMultipleUsers } = require('../services/pushNotificationService');
const { notifyPasswordResetRequest } = require('../services/telegramNotifier');
const { setResetRequested } = require('../services/userMetaService');

// POST /api/login
router.post('/login', async (req, res) => {
    console.log("New login request");
    const { username, password: clientHashedPassword } = req.body;

    try {
        // Query the user by username
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

        // Compare the received hashed password with the stored hash
        if (clientHashedPassword !== user.password) {
            console.log("Invalid password for user: " + username);
            return res.status(401).json({ error: 'Invalid username or password' });
        }

        // Fetch user roles
        const { data: roles, error: rolesError } = await db
            .from('user_roles')
            .select('user_id, role_id(id, description)')
            .eq('user_id', username);

        if (rolesError) {
            console.error("Error fetching user roles:", rolesError);
            return res.status(500).json({ error: 'Failed to fetch user roles' });
        }

        // Update last_access timestamp
        const { error: updateError } = await db
            .from('users')
            .update({ last_access: new Date().toISOString() })
            .eq('id', username);

        if (updateError) {
            console.error("Error updating last_access:", updateError);
            return res.status(500).json({ error: 'Failed to update last_access' });
        }

        console.log(`Updated last_access for user: ${username}`);

        // Fetch user settings (championship and preferred language)
        const { data: userSettings } = await db
            .from('user_settings')
            .select('championship_id, language')
            .eq('user_id', username)
            .maybeSingle();

        // Generate a JWT token
        const token = jwt.sign(
            {
                userId: user.profile_id,
                username: user.id,
                email: user.email,
                firstName: user.first_name,
                lastName: user.last_name,
                roles: (roles || []).map(r => r.role_id?.description)
            },
            process.env.JWT_SECRET,
            { expiresIn: '1h' }
        );

        res.json({
            token,
            language: userSettings?.language || null,
            championship_id: userSettings?.championship_id || null
        });

    } catch (err) {
        console.error("Login error:", err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/refresh-token
router.post('/refresh-token', authMiddleware, async (req, res) => {
    try {
        const username = req.username;
        let { data: user, error } = await db
            .from('users')
            .select('*')
            .eq('id', username)
            .single();

        if (error || !user) {
            return res.status(401).json({ error: 'User not found' });
        }

        const { data: roles } = await db
            .from('user_roles')
            .select('user_id, role_id(id, description)')
            .eq('user_id', username);

        const token = jwt.sign(
            {
                userId: user.profile_id,
                username: user.id,
                email: user.email,
                firstName: user.first_name,
                lastName: user.last_name,
                roles: (roles || []).map(r => r.role_id?.description)
            },
            process.env.JWT_SECRET,
            { expiresIn: '1h' }
        );

        res.json({ token });
    } catch (err) {
        console.error('Refresh token error:', err);
        res.status(500).json({ error: 'Failed to refresh token' });
    }
});

// POST /api/request-password-reset
// Public or authenticated request from a user to notify the admin for password reset
router.post('/request-password-reset', async (req, res) => {
    try {
        let username = req.body?.username;

        // If authenticated with Bearer token, we can use authenticated username
        const authHeader = req.headers['authorization'] || req.headers['Authorization'];
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.split(' ')[1];
            try {
                const decoded = jwt.verify(token, process.env.JWT_SECRET);
                if (decoded?.username) {
                    username = decoded.username;
                }
            } catch (ignore) {}
        }

        if (!username || typeof username !== 'string' || !username.trim()) {
            return res.status(400).json({ error: 'Nome utente o email mancante' });
        }

        username = username.trim();

        // Query user by username (id) or email
        let { data: user, error: userError } = await db
            .from('users')
            .select('id, first_name, last_name, email, pwd_reset')
            .or(`id.ilike.${username},email.ilike.${username}`)
            .limit(1)
            .maybeSingle();

        if (userError) {
            console.error('Error finding user for pwd reset request:', userError);
            return res.status(500).json({ error: 'Errore durante la ricerca dell\'utente' });
        }

        if (!user) {
            return res.status(404).json({ error: `Nessun utente trovato con identificativo "${username}"` });
        }

        const displayName = `${user.first_name || ''} ${user.last_name || ''}`.trim() || user.id;

        // If reset is already enabled
        if (user.pwd_reset === 1) {
            return res.json({
                success: true,
                alreadyEnabled: true,
                message: `Il reset password per l'utente ${displayName} è già abilitato. Al prossimo accesso ti verrà richiesto di inserire una nuova password.`
            });
        }

        // Mark reset requested in metadata
        await setResetRequested(user.id, true);

        // Find all admin users (role_id: 1)
        const { data: adminRoles, error: adminErr } = await db
            .from('user_roles')
            .select('user_id')
            .eq('role_id', 1);

        if (adminErr) {
            console.error('Error fetching admins for reset request:', adminErr);
        }

        const adminUserIds = (adminRoles || []).map(r => r.user_id).filter(Boolean);

        // Send in-app notification to all admins
        for (const adminId of adminUserIds) {
            try {
                await createNotification({
                    userId: adminId,
                    category: 'password_reset',
                    title: 'Richiesta Reset Password',
                    body: `L'utente ${displayName} (@${user.id}) ha richiesto il reset della password.`,
                    type: 'warning',
                    link: '/admin?tab=users'
                });
            } catch (err) {
                console.error(`Failed to create notification for admin ${adminId}:`, err);
            }
        }

        // Send Web Push notifications to admins if subscribed
        if (adminUserIds.length > 0) {
            try {
                await sendPushToMultipleUsers(adminUserIds, {
                    notification: {
                        title: 'Richiesta Reset Password',
                        body: `L'utente ${displayName} (@${user.id}) chiede il reset della password.`,
                        data: { link: '/admin?tab=users', category: 'password_reset' },
                        icon: '/favicon.ico',
                        badge: '/favicon.ico',
                        vibrate: [200, 100, 200]
                    }
                });
            } catch (err) {
                console.warn('Failed to send push notification to admins:', err);
            }
        }

        // Send Telegram notification if enabled
        try {
            await notifyPasswordResetRequest({
                userId: user.id,
                userDisplayName: displayName,
                userEmail: user.email
            });
        } catch (err) {
            console.warn('Failed to send Telegram notification:', err);
        }

        res.json({
            success: true,
            message: `Richiesta di reset password inviata con successo all'amministratore per l'utente ${displayName}.`
        });

    } catch (err) {
        console.error('Error in request-password-reset:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
