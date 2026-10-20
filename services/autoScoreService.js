const db = require('../models/db');
const { syncMotoGPResults } = require('../routes/scrapeMotoGP');
const { calculateAndPersistStandings, loadStandingsRun } = require('../routes/calcScores');
const { buildZonedDateTime, formatYyyyMmDd } = require('../utils/championshipTime');

/**
 * Checks all active championships and concluded/running races to see if
 * approximately 30 minutes after the race finish the trigger should automatically
 * sync official Dorna results, compute scores, persist standings, and notify users.
 *
 * Timing:
 * - MotoGP main race takes ~45 minutes.
 * - "Mezz'ora dopo la gara" = raceStartTime + 45m (race) + 30m (buffer) = raceStartTime + 75m.
 * - If now >= raceStartTime + 75m (or race date has passed), it checks if scores are completed.
 * - If not completed, it fetches official MotoGP results from Dorna/Pulselive.
 * - If official results are ready, it calculates and persists standings, triggering notifications.
 */
async function checkAndExecuteAutoScoring(options = {}) {
    const logPrefix = '[AutoScoreService]';
    console.log(`${logPrefix} Running check at ${new Date().toISOString()}`);

    const resultsSummary = [];

    try {
        // 1) Fetch active or latest championships
        const { data: championships, error: champErr } = await db
            .from('championships')
            .select('id, year, description, is_active')
            .order('year', { ascending: false });

        if (champErr || !championships || championships.length === 0) {
            console.log(`${logPrefix} No championships found.`);
            return { ok: true, message: 'No championships found', processed: [] };
        }

        const now = new Date();
        const todayYmd = formatYyyyMmDd(now, 'Europe/Rome');
        // 7 days ago in YYYY-MM-DD
        const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const minDateYmd = formatYyyyMmDd(sevenDaysAgo, 'Europe/Rome');

        for (const champ of championships) {
            // Only check active or current season championships
            if (champ.is_active === false && champ.year < now.getFullYear() && !options.targetCalendarId) {
                continue;
            }

            // Check calendar races for this championship
            let query = db
                .from('calendar')
                .select('id, championship_id, race_order, event_date, event_time, sprint_time, cancelled, race_id(name, location, country)')
                .eq('championship_id', champ.id)
                .eq('cancelled', false)
                .order('race_order', { ascending: true });

            if (options.targetCalendarId) {
                query = query.eq('id', options.targetCalendarId);
            }

            const { data: races, error: raceErr } = await query;
            if (raceErr || !races || races.length === 0) continue;

            for (const race of races) {
                // If race date is in the future (> today), skip
                if (race.event_date > todayYmd) {
                    continue;
                }

                // In periodic background mode, only check recent races (last 7 days)
                if (!options.allPastRaces && !options.targetCalendarId && race.event_date < minDateYmd) {
                    continue;
                }

                // Compute race start time and 30-min-after-finish trigger time
                const eventTime = race.event_time || '14:00:00';
                const raceStartTime = buildZonedDateTime(race.event_date, eventTime, 'Europe/Rome');

                // Standard race duration: 45 min + 30 min after = 75 minutes
                const triggerTimeMs = raceStartTime ? raceStartTime.getTime() + (75 * 60 * 1000) : 0;
                const isPastRaceDate = race.event_date < todayYmd;
                const isPastTriggerTime = now.getTime() >= triggerTimeMs;

                // Only trigger if we are past the 30-min-after-finish mark or past the race day
                if (!isPastRaceDate && !isPastTriggerTime && !options.force) {
                    continue;
                }

                // Check if standings have already been successfully calculated
                const run = await loadStandingsRun(champ.id, race.id);
                if (!options.force && run?.status === 'completed') {
                    // Already calculated and persisted!
                    continue;
                }

                console.log(`${logPrefix} Triggering scoring for Round ${race.race_order} (${race.race_id?.name || 'GP'})...`);

                // Step A: Sync official Dorna results
                let syncResult = null;
                try {
                    syncResult = await syncMotoGPResults(champ.id, race.id, true);
                } catch (syncErr) {
                    console.error(`${logPrefix} Error syncing results for round ${race.race_order}:`, syncErr.message);
                }

                // Check if the race classification has been published by Dorna
                if (!syncResult?.hasRaceClassification && !options.force) {
                    console.log(`${logPrefix} Dorna has not yet published official race results for Round ${race.race_order}. Will retry on next check.`);
                    resultsSummary.push({
                        championshipId: champ.id,
                        calendarId: race.id,
                        raceOrder: race.race_order,
                        raceName: race.race_id?.name,
                        status: 'waiting_for_official_results',
                        message: 'Official race results not yet published by Dorna'
                    });
                    continue;
                }

                // Step B: Calculate and persist standings
                const calcResult = await calculateAndPersistStandings(champ.id, race.id, { force: true });

                if (calcResult.ok) {
                    console.log(`${logPrefix} SUCCESS: Scores calculated and persisted for Round ${race.race_order} (${race.race_id?.name})!`);
                    resultsSummary.push({
                        championshipId: champ.id,
                        calendarId: race.id,
                        raceOrder: race.race_order,
                        raceName: race.race_id?.name,
                        status: 'success',
                        participantsScored: calcResult.results?.length || 0
                    });
                } else {
                    console.error(`${logPrefix} FAILED: Error calculating scores for Round ${race.race_order}:`, calcResult.error);
                    resultsSummary.push({
                        championshipId: champ.id,
                        calendarId: race.id,
                        raceOrder: race.race_order,
                        raceName: race.race_id?.name,
                        status: 'error',
                        error: calcResult.error
                    });
                }
            }
        }

        return {
            ok: true,
            timestamp: now.toISOString(),
            processedCount: resultsSummary.length,
            processed: resultsSummary
        };
    } catch (err) {
        console.error(`${logPrefix} Unexpected error during check:`, err);
        return { ok: false, error: err.message, processed: resultsSummary };
    }
}

module.exports = {
    checkAndExecuteAutoScoring
};
