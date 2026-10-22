const db = require('../models/db');
const { syncMotoGPResults } = require('../routes/scrapeMotoGP');
const { calculateAndPersistStandings, loadStandingsRun } = require('../routes/calcScores');
const { buildZonedDateTime, formatYyyyMmDd, addDaysToYyyyMmDd } = require('../utils/championshipTime');

/**
 * Checks all active championships and ongoing/concluded race weekends to
 * automatically sync official Dorna results, compute scores, persist standings,
 * and notify users in near-real-time at 3 specific stages:
 *
 * 1) 30 min after Qualifying (Saturday morning): ~70 min from qualifications_time
 * 2) 30 min after Sprint Race (Saturday afternoon): ~55 min from sprint_time
 * 3) 30 min after Main Race (Sunday afternoon): ~75 min from event_time
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
                .select('id, championship_id, race_order, event_date, qualifications_time, sprint_time, event_time, cancelled, race_id(name, location, country)')
                .eq('championship_id', champ.id)
                .eq('cancelled', false)
                .order('race_order', { ascending: true });

            if (options.targetCalendarId) {
                query = query.eq('id', options.targetCalendarId);
            }

            const { data: races, error: raceErr } = await query;
            if (raceErr || !races || races.length === 0) continue;

            for (const race of races) {
                const dayBeforeRace = addDaysToYyyyMmDd(race.event_date, -1);

                // If race weekend is in the future (> today), skip
                if (!options.targetCalendarId && !options.force && todayYmd < dayBeforeRace) {
                    continue;
                }

                // In periodic background mode, only check recent races (last 7 days)
                if (!options.allPastRaces && !options.targetCalendarId && race.event_date < minDateYmd) {
                    continue;
                }

                // Check if standings have already been successfully calculated to full completion
                const run = await loadStandingsRun(champ.id, race.id);
                const currentStatus = run?.status || null;

                if (!options.force && currentStatus === 'completed') {
                    // Entire race weekend has already been scored and completed!
                    continue;
                }

                // Compute session start and trigger times
                const tz = 'Europe/Rome';
                const qualTime = race.qualifications_time || '10:50:00';
                const sprintTime = race.sprint_time || '15:00:00';
                const eventTime = race.event_time || '14:00:00';

                const qualStartTime = buildZonedDateTime(dayBeforeRace, qualTime, tz);
                const sprintStartTime = buildZonedDateTime(dayBeforeRace, sprintTime, tz);
                const raceStartTime = buildZonedDateTime(race.event_date, eventTime, tz);

                // Timings:
                // - Qualifying: ~40 min session + 30 min buffer = 70 min from start
                // - Sprint: ~25 min session + 30 min buffer = 55 min from start
                // - Race: ~45 min session + 30 min buffer = 75 min from start
                const qualTriggerMs = qualStartTime ? qualStartTime.getTime() + (70 * 60 * 1000) : 0;
                const sprintTriggerMs = sprintStartTime ? sprintStartTime.getTime() + (55 * 60 * 1000) : 0;
                const raceTriggerMs = raceStartTime ? raceStartTime.getTime() + (75 * 60 * 1000) : 0;

                const isPastRaceDate = race.event_date < todayYmd;
                const isRaceTime = isPastRaceDate || now.getTime() >= raceTriggerMs;
                const isSprintTime = isRaceTime || (todayYmd === race.event_date) || now.getTime() >= sprintTriggerMs;
                const isQualTime = isSprintTime || now.getTime() >= qualTriggerMs;

                // Determine target stage
                let targetStage = null;
                if (isRaceTime) {
                    targetStage = 'race';
                } else if (isSprintTime) {
                    if (currentStatus !== 'partial_sprint') {
                        targetStage = 'sprint';
                    }
                } else if (isQualTime) {
                    if (currentStatus !== 'partial_qualifying') {
                        targetStage = 'qualifying';
                    }
                }

                if (!targetStage && !options.force) {
                    // Not yet time for next stage or already up to date
                    continue;
                }

                console.log(`${logPrefix} Triggering scoring for Round ${race.race_order} (${race.race_id?.name || 'GP'}) - Target: ${targetStage || 'force'}...`);

                // Step A: Sync official Dorna results
                let syncResult = null;
                try {
                    syncResult = await syncMotoGPResults(champ.id, race.id, true);
                } catch (syncErr) {
                    console.error(`${logPrefix} Error syncing results for round ${race.race_order}:`, syncErr.message);
                }

                // Check if official results for target stage have been published by Dorna
                let hasOfficialResults = false;
                let missingReason = '';

                if (targetStage === 'race') {
                    hasOfficialResults = Boolean(syncResult?.hasRaceClassification);
                    missingReason = 'Official race results not yet published by Dorna';
                } else if (targetStage === 'sprint') {
                    hasOfficialResults = Boolean(syncResult?.hasSprintClassification);
                    missingReason = 'Official sprint results not yet published by Dorna';
                } else if (targetStage === 'qualifying') {
                    hasOfficialResults = Boolean(syncResult?.hasQualifyingClassification);
                    missingReason = 'Official qualifying results not yet published by Dorna';
                } else {
                    hasOfficialResults = Boolean(
                        syncResult?.hasRaceClassification ||
                        syncResult?.hasSprintClassification ||
                        syncResult?.hasQualifyingClassification
                    );
                    missingReason = 'No official results published yet by Dorna';
                }

                if (!hasOfficialResults && !options.force) {
                    console.log(`${logPrefix} Dorna has not yet published ${targetStage} results for Round ${race.race_order}. Will retry on next check.`);
                    resultsSummary.push({
                        championshipId: champ.id,
                        calendarId: race.id,
                        raceOrder: race.race_order,
                        raceName: race.race_id?.name,
                        targetStage,
                        status: 'waiting_for_official_results',
                        message: missingReason
                    });
                    continue;
                }

                // Step B: Calculate and persist standings
                const calcResult = await calculateAndPersistStandings(champ.id, race.id, { force: true });

                if (calcResult.ok) {
                    console.log(`${logPrefix} SUCCESS: Scores calculated and persisted for Round ${race.race_order} (${race.race_id?.name}) [stage: ${calcResult.runStatus || targetStage}]!`);
                    resultsSummary.push({
                        championshipId: champ.id,
                        calendarId: race.id,
                        raceOrder: race.race_order,
                        raceName: race.race_id?.name,
                        targetStage,
                        stageAchieved: calcResult.runStatus,
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
                        targetStage,
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
