const { checkAndExecuteAutoScoring } = require('./autoScoreService');

let intervalTimer = null;
let isChecking = false;
let lastCheckTime = null;
let lastCheckResult = null;

async function runCheck(options = {}) {
    if (isChecking) {
        console.log('[AutoScoreScheduler] Check already in progress, skipping tick.');
        return lastCheckResult;
    }

    isChecking = true;
    lastCheckTime = new Date().toISOString();

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

function start(intervalMs = 10 * 60 * 1000) {
    if (intervalTimer) return;

    console.log(`[AutoScoreScheduler] Service started (checking every ${intervalMs / 60000} minutes)`);

    // Warm-up check after 15 seconds
    setTimeout(() => {
        runCheck().catch(e => console.error('[AutoScoreScheduler] Startup check error:', e));
    }, 15000);

    intervalTimer = setInterval(() => {
        runCheck().catch(e => console.error('[AutoScoreScheduler] Periodic check error:', e));
    }, intervalMs);
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
        isRunning: !!intervalTimer,
        isChecking,
        lastCheckTime,
        lastCheckResult
    };
}

module.exports = {
    start,
    stop,
    runCheck,
    getStatus
};
