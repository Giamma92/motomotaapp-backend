const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const {
  getNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  deleteReadNotifications
} = require('../services/notificationService');

router.get('/notifications', authMiddleware, async (req, res) => {
  try {
    const unreadOnly = req.query.unreadOnly === 'true';
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = parseInt(req.query.offset) || 0;
    const notifications = await getNotifications(req.username, { unreadOnly, limit, offset });
    res.json(notifications);
  } catch (err) {
    console.error('Error fetching notifications:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/notifications/unread-count', authMiddleware, async (req, res) => {
  try {
    const count = await getUnreadCount(req.username);
    res.json({ count });
  } catch (err) {
    console.error('Error fetching unread count:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/notifications/:id/read', authMiddleware, async (req, res) => {
  try {
    const notification = await markAsRead(req.username, req.params.id);
    res.json(notification);
  } catch (err) {
    console.error('Error marking notification as read:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/notifications/read-all', authMiddleware, async (req, res) => {
  try {
    await markAllAsRead(req.username);
    res.json({ success: true });
  } catch (err) {
    console.error('Error marking all notifications as read:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/notifications/read', authMiddleware, async (req, res) => {
  try {
    await deleteReadNotifications(req.username);
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting read notifications:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
