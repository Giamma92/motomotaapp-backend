const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const {
  getNotificationSettings,
  upsertNotificationSettings
} = require('../services/notificationService');

router.get('/notification-settings/:championship_id', authMiddleware, async (req, res) => {
  try {
    const championshipId = parseInt(req.params.championship_id);
    if (!Number.isInteger(championshipId)) {
      return res.status(400).json({ error: 'championship_id must be an integer' });
    }

    const settings = await getNotificationSettings(req.username, championshipId);

    if (!settings) {
      return res.json({
        lineup: true,
        race_bet: true,
        sprint_bet: true,
        score_update: true,
        standing_change: true,
        race_cancelled: true,
        general: true
      });
    }

    res.json(settings);
  } catch (err) {
    console.error('Error fetching notification settings:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/notification-settings/:championship_id', authMiddleware, async (req, res) => {
  try {
    const championshipId = parseInt(req.params.championship_id);
    if (!Number.isInteger(championshipId)) {
      return res.status(400).json({ error: 'championship_id must be an integer' });
    }

    const settings = await upsertNotificationSettings(req.username, championshipId, req.body);
    res.json(settings);
  } catch (err) {
    console.error('Error updating notification settings:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
