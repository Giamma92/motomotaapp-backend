const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { runCheck, getStatus } = require('../services/autoScoreScheduler');

// Helper to verify authorization (CRON_SECRET header/query OR Admin JWT)
function verifyCronAuth(req) {
    const cronSecret = process.env.CRON_SECRET;

    // 1) Vercel Cron header
    if (req.headers['x-vercel-cron']) {
        return true;
    }

    // 2) Secret token in header or query
    const providedSecret = req.headers['x-cron-secret'] || req.query.secret;
    if (cronSecret && providedSecret && providedSecret === cronSecret) {
        return true;
    }

    // 3) JWT token with Admin role
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            if (decoded && Array.isArray(decoded.roles) && decoded.roles.includes('Admin')) {
                return true;
            }
        } catch (_) {}
    }

    // 4) In local development (no CRON_SECRET configured)
    if (!cronSecret && (process.env.NODE_ENV !== 'production' || !process.env.VERCEL)) {
        return true;
    }

    return false;
}

// GET /api/cron/auto-score
// Main webhook / Vercel cron entry point
router.get('/cron/auto-score', async (req, res) => {
    if (!verifyCronAuth(req)) {
        return res.status(401).json({ error: 'Unauthorized: invalid or missing cron secret/admin credentials' });
    }

    const force = String(req.query.force || '').toLowerCase() === 'true';
    const targetCalendarId = req.query.calendarId ? Number(req.query.calendarId) : undefined;

    try {
        const result = await runCheck({ force, targetCalendarId });
        return res.json(result);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// POST /api/cron/auto-score/run
// Admin on-demand trigger
router.post('/cron/auto-score/run', async (req, res) => {
    if (!verifyCronAuth(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const force = req.body?.force === true || String(req.query.force || '').toLowerCase() === 'true';
    const targetCalendarId = req.body?.calendarId || (req.query.calendarId ? Number(req.query.calendarId) : undefined);

    try {
        const result = await runCheck({ force, targetCalendarId });
        return res.json(result);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// GET /api/cron/auto-score/status
// Status of the auto-score service
router.get('/cron/auto-score/status', (req, res) => {
    const status = getStatus();
    return res.json(status);
});

module.exports = router;
