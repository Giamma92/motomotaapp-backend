const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const db = require('../models/db');

router.get('/user/settings', authMiddleware, async (req, res) => {
    try {
      const username = req.username; // Assuming the user ID is available from the authentication middleware
  
      // Fetch user settings from the database
      const { data, error } = await db
        .from('user_settings')
        .select('championship_id')
        .eq('user_id', username)
        .maybeSingle();
  
      if (error) {
        return res.status(500).json({ error: error.message });
      }
  
      if (!data) {
        return res.status(404).json({ error: 'User settings not found' });
      }
  
      res.json(data);
    } catch (err) {
      console.error('Error fetching user settings:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
  

router.put('/user/settings', authMiddleware, async (req, res) => {
    try {
      const username = req.username; // Assuming the authenticated user ID is available in req.user
      const { championship_id } = req.body;

      console.log("Update user: " + username + ", championship: " + championship_id)
  
      if (!championship_id) {
        return res.status(400).json({ error: 'championship_id is required' });
      }
  
      // Check if the championship exists
      const { data: championship, error: championshipError } = await db
        .from('championships')
        .select('id')
        .eq('id', championship_id)
        .maybeSingle();
  
      if (championshipError) {
        return res.status(500).json({ error: championshipError.message });
      }
      if (!championship) {
        return res.status(404).json({ error: 'Championship not found' });
      }
  
      // Update or insert user_settings
      const { data, error } = await db
        .from('user_settings')
        .upsert({ user_id: username, championship_id }, { onConflict: ['user_id'] })
        .select()
        .maybeSingle();
  
      if (error) {
        return res.status(500).json({ error: error.message });
      }
  
      res.json({ message: 'User settings updated successfully', data });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
  

module.exports = router;