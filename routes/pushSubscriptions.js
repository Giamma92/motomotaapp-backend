const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const { saveSubscription, deleteSubscription, getVapidPublicKey } = require('../services/pushNotificationService');

router.get('/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: getVapidPublicKey() });
});

router.post('/push/subscribe', authMiddleware, async (req, res) => {
  try {
    const subscription = req.body;
    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return res.status(400).json({ error: 'Invalid push subscription object' });
    }

    const result = await saveSubscription(req.username, subscription);
    if (!result) {
      return res.status(500).json({ error: 'Failed to save push subscription' });
    }

    res.status(201).json({ success: true });
  } catch (err) {
    console.error('Error saving push subscription:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/push/unsubscribe', authMiddleware, async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) {
      return res.status(400).json({ error: 'endpoint is required' });
    }

    await deleteSubscription(req.username, endpoint);
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting push subscription:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
