const { checkAndExecuteAutoScoring } = require('./autoScoreService');

const CHECK_INTERVAL_MS = 10 * 60 * 1000;

let intervalTimer = null;
let isChecking = false;
let lastCheckTime = null;
let lastCheckMs = 0;
let lastCheckResult = null;
let opportunisticEnabled = false;

async function runCheck(options = {}) {
    if (isChecking) {
        console.log('[AutoScoreScheduler] Check already in progress, skipping tick.');
        return lastCheckResult;
    }

    isChecking = true;
    const now = new Date();
    lastCheckTime = now.toISOString();
    lastCheckMs = now.getTime();

    try {
        const result = await checkAndExecuteAutoScoring(options);
        lastCheckResult = result;
        return result;
    } catch (err) {
        console.error('[AutoScoreScheduler] Error running auto-score check:', err);
        lastCheckResult = { ok: false, error: err.message, timestamp: lastCheckTime };
        return lastCheckResult;
    } finally {
        isChecking = false;
    }
}

function start(intervalMs = CHECK_INTERVAL_MS) {
    opportunisticEnabled = true;
    if (intervalTimer) return;

    console.log(`[AutoScoreScheduler] Service started (checking every ${intervalMs / 60000} minutes)`);

    // Warm-up check after 15 seconds
    const warmup = setTimeout(() => {
        runCheck().catch(e => console.error('[AutoScoreScheduler] Startup check error:', e));
    }, 15000);
    if (typeof warmup.unref === 'function') warmup.unref();

    intervalTimer = setInterval(() => {
        runCheck().catch(e => console.error('[AutoScoreScheduler] Periodic check error:', e));
    }, intervalMs);
    if (typeof intervalTimer.unref === 'function') intervalTimer.unref();
}

function maybeTickOnRequest(intervalMs = CHECK_INTERVAL_MS) {
    opportunisticEnabled = true;
    if (isChecking) return;
    if (Date.now() - lastCheckMs < intervalMs) return;

    runCheck().catch(e => console.error('[AutoScoreScheduler] Opportunistic check error:', e));
}

function stop() {
    if (intervalTimer) {
        clearInterval(intervalTimer);
        intervalTimer = null;
        console.log('[AutoScoreScheduler] Service stopped.');
    }
}

function getStatus() {
    return {
        isRunning: Boolean(intervalTimer || opportunisticEnabled),
        isChecking,
        lastCheckTime,
        lastCheckResult
    };
}

module.exports = {
    start,
    stop,
    runCheck,
    maybeTickOnRequest,
    getStatus
};
