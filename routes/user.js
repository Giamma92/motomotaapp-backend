const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const db = require('../models/db');
const { getAlias, setAlias } = require('../services/userMetaService');

// GET /api/user-info
router.get('/user-info', authMiddleware, async (req, res) => {
    console.log("New user info request for userId:", req.userId);

    // Query the user by profile_id
    let { data: userInfo, error } = await db
        .from('users')
        .select("id,profile_id,profile_image,first_name,last_name,last_access,email,pwd_reset")
        .eq('profile_id', req.userId)
        .single();

    if (error) return res.status(500).json({ error });

    if (!userInfo) {
        return res.status(404).json({ error: 'User not found' });
    }

    userInfo.alias = await getAlias(userInfo.id);
    res.json(userInfo);
});

// PUT /api/user-info
router.put('/user-info', authMiddleware, async (req, res) => {
    let { first_name, last_name, profile_image, alias } = req.body;
    try {
        // Query user first to know their username id
        const { data: currentUser, error: fetchErr } = await db
            .from('users')
            .select('id, profile_id')
            .eq('profile_id', req.userId)
            .single();

        if (fetchErr || !currentUser) {
            return res.status(404).json({ error: 'User not found' });
        }

        const updateData = {};
        if (first_name !== undefined) updateData.first_name = first_name.trim();
        if (last_name !== undefined) updateData.last_name = last_name.trim();

        // If profile_image is a base64 Data URL, upload it to Supabase Storage 'avatars'
        if (profile_image && typeof profile_image === 'string' && profile_image.startsWith('data:image/')) {
            try {
                const matches = profile_image.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
                if (matches && matches.length === 3) {
                    const mimeType = matches[1];
                    const buffer = Buffer.from(matches[2], 'base64');
                    const ext = mimeType.includes('png') ? 'png' : 'jpg';
                    const fileName = `avatar_${currentUser.id}_${Date.now()}.${ext}`;

                    const { error: uploadError } = await db.storage
                        .from('avatars')
                        .upload(fileName, buffer, {
                            contentType: mimeType,
                            upsert: true
                        });

                    if (uploadError) {
                        console.error('Failed to upload avatar to storage:', uploadError);
                        return res.status(500).json({ error: 'Impossibile caricare l\'immagine profilo nello storage' });
                    }

                    const { data: pubData } = db.storage.from('avatars').getPublicUrl(fileName);
                    updateData.profile_image = pubData.publicUrl;
                }
            } catch (imgErr) {
                console.error('Error processing base64 avatar:', imgErr);
                return res.status(400).json({ error: 'Formato immagine non valido' });
            }
        } else if (profile_image !== undefined) {
            // Already a URL or empty
            updateData.profile_image = profile_image;
        }

        let updatedUser = null;
        if (Object.keys(updateData).length > 0) {
            const { data, error } = await db
                .from('users')
                .update(updateData)
                .eq('profile_id', req.userId)
                .select('id,profile_id,profile_image,first_name,last_name,last_access,email,pwd_reset')
                .single();

            if (error) {
                console.error('Error updating user info:', error);
                return res.status(500).json({ error: error.message });
            }
            updatedUser = data;
        } else {
            const { data } = await db
                .from('users')
                .select('id,profile_id,profile_image,first_name,last_name,last_access,email,pwd_reset')
                .eq('profile_id', req.userId)
                .single();
            updatedUser = data;
        }

        // Handle alias
        if (alias !== undefined) {
            await setAlias(currentUser.id, alias);
            updatedUser.alias = alias ? alias.trim() : null;
        } else {
            updatedUser.alias = await getAlias(currentUser.id);
        }

        return res.json(updatedUser);
    } catch (err) {
        console.error('Unexpected error updating user info:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
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
