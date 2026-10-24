const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const authMiddleware = require('../middleware/authMiddleware');
const authorizeRoles = require('../middleware/authorizeRoles');
const {
    notifyChampionshipUsers,
    filterByNotificationSettings
} = require('../services/notificationService');
const { sendPushToUser } = require('../services/pushNotificationService');
const {
    DEFAULT_CHAMPIONSHIP_TIMEZONE,
    formatSqlTimestamp,
    getChampionshipWindow,
    normalizeTimeZone
} = require('../utils/championshipTime');

router.get('/championship/:id/calendar/:calendar_id/calc-scores/', authMiddleware, authorizeRoles('Admin'), async (req, res) => {
    const parsed = parseIds(req.params.id, req.params.calendar_id);
    if (!parsed) {
        return res.status(400).json({ error: 'championship_id and calendar_id must be integers' });
    }

    const result = await calculateAndPersistStandings(parsed.championshipId, parsed.calendarId, { force: false });
    if (!result.ok) {
        return res.status(result.status || 500).json({ error: result.error || 'Failed to calculate standings' });
    }

    res.json({
        results: result.results.map(toLegacyResponse),
        meta: buildScoringMeta(result.scoringContext)
    });
});

router.post('/championship/:id/calendar/:calendar_id/recalculate-scores/', authMiddleware, authorizeRoles('Admin'), async (req, res) => {
    const parsed = parseIds(req.params.id, req.params.calendar_id);
    if (!parsed) {
        return res.status(400).json({ error: 'championship_id and calendar_id must be integers' });
    }

    const invalidated = await invalidateRaceScores(parsed.championshipId, parsed.calendarId);
    if (!invalidated.ok) {
        return res.status(invalidated.status || 500).json({ error: invalidated.error || 'Failed to invalidate race standings' });
    }

    const recalculated = await calculateAndPersistStandings(parsed.championshipId, parsed.calendarId, { force: true });
    if (!recalculated.ok) {
        return res.status(recalculated.status || 500).json({ error: recalculated.error || 'Failed to recalculate standings' });
    }

    res.json({
        results: recalculated.results.map(toLegacyResponse),
        meta: buildScoringMeta(recalculated.scoringContext)
    });
});

router.post('/championship/:id/recalculate-all', authMiddleware, authorizeRoles('Admin'), async (req, res) => {
    const championshipId = Number(req.params.id);
    if (!Number.isInteger(championshipId)) {
        return res.status(400).json({ error: 'championship_id must be an integer' });
    }

    try {
        const { data: races, error } = await db
            .from('calendar')
            .select('id, race_order, event_date, cancelled')
            .eq('championship_id', championshipId)
            .eq('cancelled', false)
            .order('race_order', { ascending: true });

        if (error) return res.status(500).json({ error: error.message });

        const today = new Date().toISOString().split('T')[0];
        const concludedRaces = (races || []).filter(r => r.event_date <= today);

        const resultsSummary = [];
        for (const race of concludedRaces) {
            await invalidateRaceScores(championshipId, race.id);
            const calcRes = await calculateAndPersistStandings(championshipId, race.id, { force: true });
            resultsSummary.push({
                calendarId: race.id,
                raceOrder: race.race_order,
                ok: calcRes.ok,
                usersCount: calcRes.ok ? calcRes.results?.length : 0
            });
        }

        res.json({
            success: true,
            totalConcluded: concludedRaces.length,
            recalculated: resultsSummary
        });
    } catch (err) {
        console.error('Error in recalculate-all:', err);
        res.status(500).json({ error: err.message });
    }
});

function parseIds(championshipIdRaw, calendarIdRaw) {
    const championshipId = Number(championshipIdRaw);
    const calendarId = Number(calendarIdRaw);

    if (!Number.isInteger(championshipId) || !Number.isInteger(calendarId)) {
        return null;
    }

    return { championshipId, calendarId };
}

async function calculateAndPersistStandings(championshipId, calendarId, { force = false } = {}) {
    const [
        fantasyTeams,
        initialLineups,
        raceBets,
        sprintBets,
        motogpResults,
        existingRun,
        scoringContext
    ] = await Promise.all([
        loadFantasyTeams(championshipId),
        loadLineups(championshipId, calendarId),
        loadRaceBets(championshipId, calendarId),
        loadSprintBets(championshipId, calendarId),
        loadMotoGPResults(championshipId, calendarId),
        loadStandingsRun(championshipId, calendarId),
        loadScoringContext(championshipId, calendarId)
    ]);

    if (!Array.isArray(fantasyTeams)) {
        return { ok: false, status: 500, error: 'Fail to load fantasy teams' };
    }
    if (!Array.isArray(initialLineups)) {
        return { ok: false, status: 500, error: 'Fail to load lineups' };
    }
    if (!Array.isArray(raceBets)) {
        return { ok: false, status: 500, error: 'Fail to load race bets' };
    }
    if (!Array.isArray(sprintBets)) {
        return { ok: false, status: 500, error: 'Fail to load sprint bets' };
    }
    if (!Array.isArray(motogpResults)) {
        return { ok: false, status: 500, error: 'Fail to load motogp results' };
    }
    if (!scoringContext) {
        return { ok: false, status: 500, error: 'Fail to load scoring context' };
    }
    if (motogpResults.length === 0) {
        return {
            ok: false,
            status: 409,
            error: `No MotoGP results found for championship ${championshipId}, calendar ${calendarId}. Fetch and save race results first.`
        };
    }

    const effectiveScoringContext = enhanceScoringContextWithResults(scoringContext, motogpResults);

    const ensuredLineups = await ensureMissingLineupsForScoring(
        championshipId,
        calendarId,
        fantasyTeams,
        initialLineups,
        effectiveScoringContext?.timeZone
    );
    if (!Array.isArray(ensuredLineups)) {
        return { ok: false, status: 500, error: 'Fail to prepare fallback lineups for scoring' };
    }

    const outcomesSynced = await syncBetOutcomes(
        championshipId,
        calendarId,
        sprintBets,
        raceBets,
        motogpResults,
        effectiveScoringContext
    );
    if (!outcomesSynced) {
        return { ok: false, status: 500, error: 'Fail to update bet outcomes' };
    }

    logCalculationContext(championshipId, calendarId, {
        fantasyTeams,
        lineups: ensuredLineups,
        raceBets,
        sprintBets,
        motogpResults,
        scoringContext: effectiveScoringContext
    });

    const results = calculateRaceScores({
        championshipId,
        calendarId,
        fantasyTeams,
        lineups: ensuredLineups,
        raceBets,
        sprintBets,
        motogpResults,
        scoringContext: effectiveScoringContext
    });

    const sourceHash = computeSourceHash({
        championshipId,
        calendarId,
        fantasyTeams,
        lineups: ensuredLineups,
        raceBets,
        sprintBets,
        motogpResults,
        scoringContext: effectiveScoringContext
    });

    let runStatus = 'completed';
    if (!effectiveScoringContext.raceSettled) {
        if (effectiveScoringContext.sprintSettled) {
            runStatus = 'partial_sprint';
        } else if (effectiveScoringContext.qualifyingSettled) {
            runStatus = 'partial_qualifying';
        }
    }

    const encodedSourceHash = `${runStatus}:${sourceHash}`;
    const existingStage = existingRun?.stage || (existingRun?.status === 'completed' ? 'completed' : null);

    if (!force && existingRun?.status === 'completed' && existingStage === runStatus && (existingRun.source_hash === encodedSourceHash || existingRun.source_hash === sourceHash)) {
        console.log(`Standings already up to date for championship ${championshipId}, calendar ${calendarId} (${runStatus})`);
        return { ok: true, results, scoringContext: effectiveScoringContext, runStatus };
    }

    const entriesPayload = results.map(result => ({
        championship_id: championshipId,
        calendar_id: calendarId,
        user_id: result.user_id,
        qualifying_score: result.qualifying_score,
        race_score: result.race_score,
        sprint_bet_score: result.sprint_bet_score,
        sprint_bet_delta: result.sprint_bet_delta,
        race_bet_score: result.race_bet_score,
        race_bet_delta: result.race_bet_delta,
        score: result.score,
        source_hash: encodedSourceHash,
        calculated_at: new Date().toISOString()
    }));

    const runPayload = {
        championship_id: championshipId,
        calendar_id: calendarId,
        status: 'running',
        source_hash: encodedSourceHash,
        calculated_at: new Date().toISOString(),
        last_error: null
    };

    const runStarted = await upsertStandingsRun(runPayload);
    if (!runStarted) {
        return { ok: false, status: 500, error: 'Fail to mark standings calculation as running' };
    }

    const entriesSaved = await upsertStandingsEntries(entriesPayload);
    if (!entriesSaved) {
        await upsertStandingsRun({
            ...runPayload,
            status: 'failed',
            last_error: 'Failed to save standings entries'
        });
        return { ok: false, status: 500, error: 'Fail to save standings entries' };
    }

    const allEntries = await loadStandingsEntries(championshipId);
    if (!Array.isArray(allEntries)) {
        await upsertStandingsRun({
            ...runPayload,
            status: 'failed',
            last_error: 'Failed to load standings entries'
        });
        return { ok: false, status: 500, error: 'Fail to load standings entries' };
    }

    const aggregatedStandings = buildAggregatedStandings(championshipId, fantasyTeams, allEntries);

    // Snapshot existing positions BEFORE updating standings so we can detect movements
    let oldPos = new Map();
    try {
        const { data: oldStandings, error: standingsError } = await db
            .from('standings')
            .select('user_id, position')
            .eq('championship_id', championshipId);
        if (!standingsError && Array.isArray(oldStandings)) {
            oldPos = new Map(oldStandings.map(s => [s.user_id, s.position]));
        }
    } catch (err) {
        console.error('Error fetching old standings for notifications:', err);
    }
    const standingsUpdated = await updateStandings(aggregatedStandings);
    if (!standingsUpdated) {
        await upsertStandingsRun({
            ...runPayload,
            status: 'failed',
            last_error: 'Failed to update standings snapshot'
        });
        return { ok: false, status: 500, error: 'Fail to update standings snapshot' };
    }

    // Standing change notifications: build per-user messages, respect the
    // per-user settings, verify the insert result (supabase never throws) and
    // push to the affected devices. The promise is awaited before returning so
    // serverless hosts cannot freeze the sends mid-flight.
    const standingChangeNotifications = (async () => {
      try {
        const changed = aggregatedStandings.filter(a => {
          const prev = oldPos.get(a.user_id);
          return prev && prev !== a.position;
        });

        if (changed.length === 0) return;

        const allowedIds = new Set(
          await filterByNotificationSettings(changed.map(a => a.user_id), championshipId, 'standing_change')
        );

        const notifs = changed
          .filter(a => allowedIds.has(a.user_id))
          .map(a => ({
            user_id: a.user_id,
            championship_id: championshipId,
            category: 'standing_change',
            title: a.position < oldPos.get(a.user_id)
              ? `Sei salito al #${a.position} in classifica!`
              : `Sei sceso al #${a.position} in classifica`,
            body: null,
            type: 'info',
            link: '/standings-breakdown'
          }));

        if (notifs.length === 0) return;

        const { error: insertError } = await db.from('notifications').insert(notifs);
        if (insertError) throw insertError;

        for (const n of notifs) {
          try {
            await sendPushToUser(n.user_id, {
              notification: {
                title: n.title,
                body: n.title,
                data: { link: n.link, category: 'standing_change', championshipId },
                icon: '/favicon.ico',
                badge: '/favicon.ico',
                vibrate: [200, 100, 200]
              }
            });
          } catch (err) {
            console.error('Failed to send standing change push:', err);
          }
        }
      } catch (err) {
        console.error('Failed to send standing change notifications:', err);
      }
    })();
    await standingChangeNotifications;

    await upsertStandingsRun({
        ...runPayload,
        status: 'completed',
        source_hash: encodedSourceHash,
        last_error: null
    });

    try {
      const { data: cal } = await db
        .from('calendar')
        .select('race_id(name)')
        .eq('championship_id', championshipId)
        .eq('id', calendarId)
        .maybeSingle();

      const raceName = cal?.race_id?.name || 'Gara';
      let notifTitle = 'Punteggi aggiornati';
      let notifBody = `I punteggi per ${raceName} sono stati calcolati.`;
      if (effectiveScoringContext.raceSettled) {
        notifTitle = '🏁 Classifica finale aggiornata';
        notifBody = `I punteggi definitivi per ${raceName} sono stati calcolati.`;
      } else if (effectiveScoringContext.sprintSettled) {
        notifTitle = '⚡ Punteggi parziali: Sprint';
        notifBody = `I punteggi e le scommesse Sprint per ${raceName} sono stati calcolati.`;
      } else if (effectiveScoringContext.qualifyingSettled) {
        notifTitle = '⏱️ Punteggi parziali: Qualifiche';
        notifBody = `I punteggi delle qualifiche per ${raceName} sono stati calcolati.`;
      }

      // Deduplicate score_update notifications within a 12-hour window for the same race & stage
      const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
      const { data: recentDuplicateNotifs } = await db
        .from('notifications')
        .select('id')
        .eq('championship_id', championshipId)
        .eq('category', 'score_update')
        .eq('title', notifTitle)
        .eq('body', notifBody)
        .gte('created_at', twelveHoursAgo)
        .limit(1);

      if (!recentDuplicateNotifs || recentDuplicateNotifs.length === 0) {
        await notifyChampionshipUsers({
          championshipId,
          excludeUserId: null,
          category: 'score_update',
          title: notifTitle,
          body: notifBody,
          type: 'info',
          link: `/standings-breakdown`
        });
      }
    } catch (err) {
      console.error('Failed to send score update notification:', err);
    }

    await standingChangeNotifications;

    return { ok: true, results, scoringContext: effectiveScoringContext, runStatus };
}

function isPositiveNumber(value) {
    if (value === null || value === undefined || value === '') {
        return false;
    }
    const num = Number(value);
    return Number.isFinite(num) && num > 0;
}

function hasQualifyingResults(motogpResults) {
    return (motogpResults || []).some(result =>
        isPositiveNumber(result?.qualifying_scoring_position) ||
        isPositiveNumber(result?.qualifying_position) ||
        isPositiveNumber(result?.qualifying_scoring_points) ||
        isPositiveNumber(result?.qualifying_points)
    );
}

function hasSprintResults(motogpResults) {
    return (motogpResults || []).some(result =>
        isPositiveNumber(result?.sprint_position) ||
        isPositiveNumber(result?.sprint_points)
    );
}

function hasRaceResults(motogpResults) {
    return (motogpResults || []).some(result =>
        isPositiveNumber(result?.race_position) ||
        isPositiveNumber(result?.race_points)
    );
}

function enhanceScoringContextWithResults(scoringContext, motogpResults) {
    const resultDrivenFlags = {
        qualifyingSettled: hasQualifyingResults(motogpResults),
        sprintSettled: hasSprintResults(motogpResults),
        raceSettled: hasRaceResults(motogpResults)
    };

    return {
        ...scoringContext,
        qualifyingSettled: Boolean(resultDrivenFlags.qualifyingSettled),
        sprintSettled: Boolean(resultDrivenFlags.sprintSettled),
        raceSettled: Boolean(resultDrivenFlags.raceSettled)
    };
}

async function invalidateRaceScores(championshipId, calendarId) {
    const fantasyTeams = await loadFantasyTeams(championshipId);
    if (!Array.isArray(fantasyTeams)) {
        return { ok: false, status: 500, error: 'Fail to load fantasy teams' };
    }

    const entriesDeleted = await deleteStandingsEntries(championshipId, calendarId);
    if (!entriesDeleted) {
        return { ok: false, status: 500, error: 'Fail to delete standings entries' };
    }

    const runUpdated = await upsertStandingsRun({
        championship_id: championshipId,
        calendar_id: calendarId,
        status: 'invalidated',
        source_hash: null,
        calculated_at: new Date().toISOString(),
        last_error: null
    });
    if (!runUpdated) {
        return { ok: false, status: 500, error: 'Fail to invalidate standings run' };
    }

    const allEntries = await loadStandingsEntries(championshipId);
    if (!Array.isArray(allEntries)) {
        return { ok: false, status: 500, error: 'Fail to load standings entries' };
    }

    const aggregatedStandings = buildAggregatedStandings(championshipId, fantasyTeams, allEntries);
    const standingsUpdated = await updateStandings(aggregatedStandings);
    if (!standingsUpdated) {
        return { ok: false, status: 500, error: 'Fail to update standings snapshot' };
    }

    return { ok: true };
}

function calculateRaceScores({
    championshipId,
    calendarId,
    fantasyTeams,
    lineups,
    raceBets,
    sprintBets,
    motogpResults,
    scoringContext
}) {
    const lineupByUser = new Map(lineups.map(lineup => [normalizeUserId(lineup.user_id), lineup]));
    const raceBetByUser = new Map(raceBets.map(bet => [normalizeUserId(bet.user_id), bet]));
    const sprintBetByUser = new Map(sprintBets.map(bet => [normalizeUserId(bet.user_id), bet]));
    const resultByRider = new Map(motogpResults.map(result => [normalizeEntityId(result.rider_id), result]));
    const rawResults = fantasyTeams.map(team => {
        const userId = normalizeUserId(team.user_id?.id);
        const lineup = lineupByUser.get(userId);
        const raceBet = raceBetByUser.get(userId);
        const sprintBet = sprintBetByUser.get(userId);
        const hasManualLineup = Boolean(lineup) && !lineup.automatically_inserted;

        const qualifyingResult = lineup?.qualifying_rider_id?.id
            ? resultByRider.get(normalizeEntityId(lineup.qualifying_rider_id.id))
            : null;
        const raceResult = lineup?.race_rider_id?.id
            ? resultByRider.get(normalizeEntityId(lineup.race_rider_id.id))
            : null;
        const sprintBetResult = sprintBet?.rider_id
            ? resultByRider.get(normalizeEntityId(sprintBet.rider_id))
            : null;
        const raceBetResult = raceBet?.rider_id
            ? resultByRider.get(normalizeEntityId(raceBet.rider_id))
            : null;

        const qualifyingScore = scoringContext.qualifyingSettled
            ? Number(qualifyingResult?.qualifying_scoring_points || qualifyingResult?.qualifying_points || 0)
            : 0;
        const raceScore = scoringContext.raceSettled
            ? getRacePoints(raceResult)
            : 0;
        const sprintBetScore = Number(sprintBet?.points || 0);
        const raceBetScore = Number(raceBet?.points || 0);
        const effectiveRaceBetScore = hasManualLineup ? raceBetScore : Math.min(raceBetScore, 15);

        const sprintBetDelta = scoringContext.sprintSettled
            ? calculateBetDelta(
                sprintBet?.position,
                sprintBetResult?.sprint_position,
                sprintBetScore
            )
            : 0;
        const raceBetDelta = scoringContext.raceSettled
            ? calculateBetDelta(
                raceBet?.position,
                raceBetResult?.race_position,
                effectiveRaceBetScore
            )
            : 0;

        const ownScore = qualifyingScore + raceScore + sprintBetDelta + raceBetDelta;

        logUserCalculation({
            championshipId,
            calendarId,
            userId,
            teamName: team.name,
            automaticallyInserted: Boolean(lineup?.automatically_inserted),
            lineup,
            raceBet,
            sprintBet,
            qualifyingResult,
            raceResult,
            sprintBetResult,
            raceBetResult,
            qualifyingScore,
            raceScore,
            sprintBetScore,
            sprintBetDelta,
            raceBetScore,
            raceBetDelta,
            ownScore,
            scoringContext
        });

        return {
            championship_id: championshipId,
            calendar_id: calendarId,
            user_id: userId,
            first_name: `${team.user_id.first_name || ''} ${team.user_id.last_name || ''}`.trim(),
            team_name: team.name,
            automatically_inserted: Boolean(lineup?.automatically_inserted),
            uses_fallback_score: !hasManualLineup,
            qualifying_score: qualifyingScore,
            race_score: raceScore,
            sprint_bet_score: sprintBetScore,
            sprint_bet_delta: sprintBetDelta,
            race_bet_score: raceBetScore,
            race_bet_delta: raceBetDelta,
            has_race_bet: Boolean(raceBet),
            own_score: ownScore,
            score: ownScore
        };
    });

    const raceBetDeltas = rawResults
        .filter(result => result.uses_fallback_score && result.has_race_bet)
        .map(result => Number(result.race_bet_delta || 0));
    const fallbackScore = raceBetDeltas.length > 0 ? Math.min(Math.min(...raceBetDeltas), 0) : 0;

    return rawResults.map(result => {
        if (!result.uses_fallback_score) {
            return {
                ...result,
                score: result.own_score
            };
        }

        const noLineupBetScore = calculateNoLineupBetScore(result, fallbackScore);

        return {
            ...result,
            qualifying_score: 0,
            race_score: 0,
            sprint_bet_score: 0,
            sprint_bet_delta: result.sprint_bet_delta,
            race_bet_score: 0,
            race_bet_delta: result.race_bet_delta,
            score: noLineupBetScore
        };
    });
}

function calculateNoLineupBetScore(result, fallbackScore) {
    if (result.has_race_bet) {
        return Number(result.race_bet_delta || 0);
    }

    return fallbackScore;
}

function getRacePoints(result) {
    if (!result) return 0;

    if (result.race_points !== null && result.race_points !== undefined && result.race_points !== '') {
        const explicitPoints = Number(result.race_points);
        if (Number.isFinite(explicitPoints)) {
            return explicitPoints;
        }
    }

    if (!isPositiveNumber(result.race_position)) {
        return 0;
    }

    return getMotoGPPoints(result.race_position);
}

function calculateBetDelta(selectedPosition, actualPosition, betScore) {
    if (selectedPosition === null || selectedPosition === undefined || selectedPosition === '') {
        return 0;
    }
    const selected = Number(selectedPosition);
    const score = Number(betScore || 0);

    if (!Number.isFinite(selected) || selected <= 0 || !Number.isFinite(score) || score === 0) {
        return 0;
    }
    if (!isPositiveNumber(actualPosition)) {
        return -Math.floor(score / 2);
    }
    const actual = Number(actualPosition);
    if (selected === actual || selected === (actual - 1)) {
        return score;
    }
    return -Math.floor(score / 2);
}

function buildAggregatedStandings(championshipId, fantasyTeams, entries) {
    const scoreByUser = new Map();

    entries.forEach(entry => {
        const userId = normalizeUserId(entry.user_id);
        const current = scoreByUser.get(userId) || 0;
        scoreByUser.set(userId, current + Number(entry.score || 0));
    });

    return fantasyTeams
        .map(team => ({
            user_id: normalizeUserId(team.user_id?.id),
            championship_id: championshipId,
            score: scoreByUser.get(normalizeUserId(team.user_id?.id)) || 0
        }))
        .sort((a, b) => b.score - a.score)
        .map((standing, index) => ({
            ...standing,
            position: index + 1
        }));
}

function normalizeUserId(userId) {
    if (userId == null) {
        return null;
    }

    return String(userId);
}

function normalizeEntityId(entityId) {
    if (entityId == null) {
        return null;
    }

    if (typeof entityId === 'object' && entityId.id != null) {
        return String(entityId.id);
    }

    return String(entityId);
}

function logCalculationContext(championshipId, calendarId, datasets) {
    const riderSamples = (datasets.motogpResults || []).slice(0, 8).map(result => ({
        rider_id: result.rider_id,
        normalized_rider_id: normalizeEntityId(result.rider_id),
        qualifying_position: result.qualifying_position,
        qualifying_points: result.qualifying_points,
        qualifying_scoring_position: result.qualifying_scoring_position,
        qualifying_scoring_points: result.qualifying_scoring_points,
        qualifying_scoring_source: result.qualifying_scoring_source,
        sprint_points: result.sprint_points,
        race_points: result.race_points
    }));

    console.log('[calcScores] dataset summary', {
        championshipId,
        calendarId,
        scoringPhase: buildScoringMeta(datasets.scoringContext),
        fantasyTeams: datasets.fantasyTeams?.length ?? 0,
        lineups: datasets.lineups?.length ?? 0,
        raceBets: datasets.raceBets?.length ?? 0,
        sprintBets: datasets.sprintBets?.length ?? 0,
        motogpResults: datasets.motogpResults?.length ?? 0,
        riderSamples
    });
}

function logUserCalculation({
    championshipId,
    calendarId,
    userId,
    teamName,
    automaticallyInserted,
    lineup,
    raceBet,
    sprintBet,
    qualifyingResult,
    raceResult,
    sprintBetResult,
    raceBetResult,
    qualifyingScore,
    raceScore,
    sprintBetScore,
    sprintBetDelta,
    raceBetScore,
    raceBetDelta,
    ownScore,
    scoringContext
}) {
    console.log('[calcScores] user breakdown', {
        championshipId,
        calendarId,
        scoringPhase: buildScoringMeta(scoringContext),
        userId,
        teamName,
        automaticallyInserted,
        lineup: {
            qualifying_rider_id: lineup?.qualifying_rider_id?.id ?? lineup?.qualifying_rider_id ?? null,
            race_rider_id: lineup?.race_rider_id?.id ?? lineup?.race_rider_id ?? null
        },
        sprintBet: sprintBet
            ? {
                rider_id: sprintBet.rider_id,
                position: sprintBet.position,
                points: sprintBet.points
            }
            : null,
        raceBet: raceBet
            ? {
                rider_id: raceBet.rider_id,
                position: raceBet.position,
                points: raceBet.points
            }
            : null,
        matchedResults: {
            qualifying: qualifyingResult
                ? {
                    rider_id: qualifyingResult.rider_id,
                    qualifying_position: qualifyingResult.qualifying_position,
                    qualifying_points: qualifyingResult.qualifying_points,
                    qualifying_scoring_position: qualifyingResult.qualifying_scoring_position,
                    qualifying_scoring_points: qualifyingResult.qualifying_scoring_points,
                    qualifying_scoring_source: qualifyingResult.qualifying_scoring_source
                }
                : null,
            race: raceResult
                ? {
                    rider_id: raceResult.rider_id,
                    race_position: raceResult.race_position,
                    race_points: raceResult.race_points
                }
                : null,
            sprintBet: sprintBetResult
                ? {
                    rider_id: sprintBetResult.rider_id,
                    sprint_position: sprintBetResult.sprint_position,
                    sprint_points: sprintBetResult.sprint_points
                }
                : null,
            raceBet: raceBetResult
                ? {
                    rider_id: raceBetResult.rider_id,
                    race_position: raceBetResult.race_position,
                    race_points: raceBetResult.race_points
                }
                : null
        },
        computed: {
            qualifyingScore,
            raceScore,
            sprintBetScore,
            sprintBetDelta,
            raceBetScore,
            raceBetDelta,
            ownScore
        }
    });
}

function toLegacyResponse(result) {
    return {
        user_id: result.user_id,
        first_name: result.first_name,
        team_name: result.team_name,
        score: result.score
    };
}

function computeSourceHash(payload) {
    return crypto
        .createHash('sha256')
        .update(JSON.stringify(normalizeForHash(payload)))
        .digest('hex');
}

const VOLATILE_HASH_KEYS = new Set(['now', 'modified_at', 'calculated_at']);

function normalizeForHash(value) {
    if (Array.isArray(value)) {
        return value
            .map(item => normalizeForHash(item))
            .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    }

    if (value && typeof value === 'object') {
        return Object.keys(value)
            .filter(key => !VOLATILE_HASH_KEYS.has(key))
            .sort()
            .reduce((acc, key) => {
                acc[key] = normalizeForHash(value[key]);
                return acc;
            }, {});
    }

    return value ?? null;
}

async function loadFantasyTeams(championshipId) {
    try {
        const { data, error } = await db
            .from('fantasy_teams')
            .select(`id,
                    name,
                    user_id(id,email,first_name,last_name),
                    official_rider_1(id,first_name,last_name,number),
                    official_rider_2(id,first_name,last_name,number),
                    reserve_rider(id,first_name,last_name,number)`)
            .eq('championship_id', championshipId);

        if (error) {
            console.error('Error fetching fantasy teams:', error);
            return null;
        }

        return data || [];
    } catch (err) {
        console.error('Unexpected error fetching fantasy teams:', err);
        return null;
    }
}

function buildScoringMeta(scoringContext) {
    const phase = getScoringPhaseLabel(scoringContext);

    return {
        phase,
        partial: phase !== 'full_race_ready',
        qualifyingSettled: Boolean(scoringContext?.qualifyingSettled),
        sprintSettled: Boolean(scoringContext?.sprintSettled),
        raceSettled: Boolean(scoringContext?.raceSettled),
        message: getScoringPhaseMessage(phase),
        timeZone: scoringContext?.timeZone || DEFAULT_CHAMPIONSHIP_TIMEZONE,
        now: scoringContext?.now || null,
        qualifyingAt: scoringContext?.qualifyingAt || null,
        sprintAt: scoringContext?.sprintAt || null,
        raceAt: scoringContext?.raceAt || null
    };
}

function getScoringPhaseLabel(scoringContext) {
    if (scoringContext?.raceSettled) {
        return 'full_race_ready';
    }
    if (scoringContext?.sprintSettled) {
        return 'sprint_complete';
    }
    if (scoringContext?.qualifyingSettled) {
        return 'qualifying_complete';
    }
    return 'pre_qualifying';
}

function getScoringPhaseMessage(phase) {
    switch (phase) {
        case 'qualifying_complete':
            return 'Calcolo parziale: conteggiata solo la qualifica. Scommesse sprint e gara non ancora considerate.';
        case 'sprint_complete':
            return 'Calcolo parziale: conteggiate qualifica e sprint. Scommesse gara non ancora considerate.';
        case 'full_race_ready':
            return 'Calcolo completo: qualifica, sprint e gara sono state considerate.';
        default:
            return 'Calcolo preliminare: nessuna sessione della gara risulta ancora maturata.';
    }
}

async function loadScoringContext(championshipId, calendarId) {
    try {
        const [
            { data: config, error: configError },
            { data: calendarRow, error: calendarError }
        ] = await Promise.all([
            db
                .from('configuration')
                .select('timezone')
                .eq('championship_id', championshipId)
                .maybeSingle(),
            db
                .from('calendar')
                .select('id,event_date,qualifications_time,sprint_time,event_time,cancelled')
                .eq('championship_id', championshipId)
                .eq('id', calendarId)
                .maybeSingle()
        ]);

        if (configError) {
            console.error('Error loading championship timezone for calc scores:', configError);
            return null;
        }
        if (calendarError) {
            console.error('Error loading calendar row for calc scores:', calendarError);
            return null;
        }
        if (!calendarRow) {
            console.error('Calendar row not found for calc scores', { championshipId, calendarId });
            return null;
        }
        if (calendarRow.cancelled) {
            console.error('Cannot calculate scores for cancelled race', { championshipId, calendarId });
            return null;
        }

        const timeZone = normalizeTimeZone(config?.timezone || DEFAULT_CHAMPIONSHIP_TIMEZONE);
        const window = getChampionshipWindow(calendarRow, timeZone);
        const now = new Date();
        const qualifyingAt = window?.lineupsEnd || null;
        const sprintAt = window?.sprintBetEnd
            ? new Date(window.sprintBetEnd.getTime() + 30 * 60 * 1000)
            : null;
        const raceAt = window?.eventTime || null;

        return {
            timeZone,
            now: now.toISOString(),
            qualifyingAt: qualifyingAt?.toISOString() || null,
            sprintAt: sprintAt?.toISOString() || null,
            raceAt: raceAt?.toISOString() || null,
            qualifyingSettled: Boolean(qualifyingAt && now >= qualifyingAt),
            sprintSettled: Boolean(sprintAt && now >= sprintAt),
            raceSettled: Boolean(raceAt && now >= raceAt)
        };
    } catch (err) {
        console.error('Unexpected error loading scoring context for calc scores:', err);
        return null;
    }
}

async function loadLineups(championshipId, calendarId) {
    try {
        const { data, error } = await db
            .from('lineups')
            .select(`id,
                    race_rider_id(id,first_name,last_name,number),
                    qualifying_rider_id(id,first_name,last_name,number),
                    automatically_inserted,
                    championship_id,
                    user_id,
                    calendar_id`)
            .eq('championship_id', championshipId)
            .eq('calendar_id', calendarId);

        if (error) {
            console.error('Error fetching lineups:', error);
            return null;
        }

        return data || [];
    } catch (err) {
        console.error('Unexpected error fetching lineups:', err);
        return null;
    }
}

async function ensureMissingLineupsForScoring(championshipId, calendarId, fantasyTeams, currentLineups, timeZone) {
    try {
        const championshipTimeZone = normalizeTimeZone(timeZone || DEFAULT_CHAMPIONSHIP_TIMEZONE);
        const modifiedAt = formatSqlTimestamp(new Date(), championshipTimeZone);
        const existingUserIds = new Set((currentLineups || []).map(lineup => normalizeUserId(lineup.user_id)));
        const teamByUser = new Map((fantasyTeams || []).map(team => [normalizeUserId(team.user_id?.id), team]));
        const missingUserIds = (fantasyTeams || [])
            .map(team => normalizeUserId(team.user_id?.id))
            .filter(userId => userId && !existingUserIds.has(userId));

        if (missingUserIds.length === 0) {
            return currentLineups;
        }

        const { data: currentRace, error: currentRaceError } = await db
            .from('calendar')
            .select('id,event_date')
            .eq('championship_id', championshipId)
            .eq('id', calendarId)
            .maybeSingle();

        if (currentRaceError || !currentRace) {
            console.error('Error loading current calendar race for fallback scoring:', currentRaceError);
            return currentLineups;
        }

        const { data: previousLineups, error: previousLineupsError } = await db
            .from('lineups')
            .select('user_id,qualifying_rider_id,race_rider_id,calendar_id(id,event_date,cancelled)')
            .eq('championship_id', championshipId)
            .in('user_id', missingUserIds);

        if (previousLineupsError) {
            console.error('Error loading previous lineups for fallback scoring:', previousLineupsError);
            return null;
        }

        const latestLineupByUser = new Map();
        const orderedPreviousLineups = (previousLineups || [])
            .filter(lineup =>
                lineup.calendar_id?.event_date &&
                !lineup.calendar_id?.cancelled &&
                lineup.calendar_id.event_date < currentRace.event_date
            )
            .sort((left, right) => right.calendar_id.event_date.localeCompare(left.calendar_id.event_date));

        for (const lineup of orderedPreviousLineups) {
            const uid = normalizeUserId(lineup.user_id);
            if (!uid || latestLineupByUser.has(uid)) continue;
            latestLineupByUser.set(uid, lineup);
        }

        const rows = missingUserIds
            .map(userId => {
                const prev = latestLineupByUser.get(userId);
                if (prev?.qualifying_rider_id && prev?.race_rider_id) {
                    return {
                        championship_id: championshipId,
                        calendar_id: calendarId,
                        user_id: userId,
                        qualifying_rider_id: prev.qualifying_rider_id,
                        race_rider_id: prev.race_rider_id,
                        modified_at: modifiedAt,
                        automatically_inserted: true
                    };
                }
                const team = teamByUser.get(userId);
                const qualRiderId = normalizeEntityId(team?.official_rider_1?.id ?? team?.official_rider_1);
                const raceRiderId = normalizeEntityId(team?.official_rider_2?.id ?? team?.official_rider_2);
                if (qualRiderId && raceRiderId) {
                    return {
                        championship_id: championshipId,
                        calendar_id: calendarId,
                        user_id: userId,
                        qualifying_rider_id: qualRiderId,
                        race_rider_id: raceRiderId,
                        modified_at: modifiedAt,
                        automatically_inserted: true
                    };
                }
                return null;
            })
            .filter(Boolean);

        if (rows.length > 0) {
            const { error: insertError } = await db
                .from('lineups')
                .upsert(rows, { onConflict: 'championship_id,user_id,calendar_id' });

            if (insertError) {
                console.error('Error upserting fallback lineups for scoring:', insertError);
                return null;
            }
        }

        return await loadLineups(championshipId, calendarId);
    } catch (err) {
        console.error('Unexpected error ensuring fallback lineups for scoring:', err);
        return null;
    }
}

async function loadPreviousCalendarId(championshipId, calendarId) {
    try {
        const { data: currentRace, error: currentRaceError } = await db
            .from('calendar')
            .select('id,event_date')
            .eq('championship_id', championshipId)
            .eq('id', calendarId)
            .maybeSingle();

        if (currentRaceError || !currentRace) {
            console.error('Error loading current calendar race for fallback scoring:', currentRaceError);
            return null;
        }

        const { data: previousRace, error: previousRaceError } = await db
            .from('calendar')
            .select('id,event_date')
            .eq('championship_id', championshipId)
            .lt('event_date', currentRace.event_date)
            .order('event_date', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (previousRaceError) {
            console.error('Error loading previous calendar race for fallback scoring:', previousRaceError);
            return null;
        }

        return previousRace?.id ?? null;
    } catch (err) {
        console.error('Unexpected error loading previous calendar race for fallback scoring:', err);
        return null;
    }
}

async function loadRaceBets(championshipId, calendarId) {
    try {
        const { data, error } = await db
            .from('race_bets')
            .select(`id,user_id,championship_id,calendar_id,rider_id,position,points`)
            .eq('championship_id', championshipId)
            .eq('calendar_id', calendarId);

        if (error) {
            console.error('Error fetching race bets:', error);
            return null;
        }

        return data || [];
    } catch (err) {
        console.error('Unexpected error fetching race bets:', err);
        return null;
    }
}

async function loadSprintBets(championshipId, calendarId) {
    try {
        const { data, error } = await db
            .from('sprint_bets')
            .select(`id,user_id,championship_id,calendar_id,rider_id,position,points`)
            .eq('championship_id', championshipId)
            .eq('calendar_id', calendarId);

        if (error) {
            console.error('Error fetching sprint bets:', error);
            return null;
        }

        return data || [];
    } catch (err) {
        console.error('Unexpected error fetching sprint bets:', err);
        return null;
    }
}

async function loadMotoGPResults(championshipId, calendarId) {
    try {
        const { data, error } = await db
            .from('motogp_results')
            .select(`id,
                    rider_id,
                    championship_id,
                    calendar_id,
                    qualifying_position,
                    qualifying_points,
                    qualifying_scoring_position,
                    qualifying_scoring_points,
                    qualifying_scoring_source,
                    sprint_position,
                    sprint_points,
                    race_position,
                    race_points`)
            .eq('championship_id', championshipId)
            .eq('calendar_id', calendarId);

        if (error) {
            console.error('Error fetching motogp results:', error);
            return null;
        }

        return data || [];
    } catch (err) {
        console.error('Unexpected error fetching motogp results:', err);
        return null;
    }
}

async function loadStandingsEntries(championshipId) {
    try {
        const { data, error } = await db
            .from('standings_entries')
            .select('championship_id,calendar_id,user_id,score')
            .eq('championship_id', championshipId);

        if (error) {
            console.error('Error fetching standings entries:', error);
            return null;
        }

        return data || [];
    } catch (err) {
        console.error('Unexpected error fetching standings entries:', err);
        return null;
    }
}

async function loadStandingsRun(championshipId, calendarId) {
    try {
        const { data, error } = await db
            .from('standings_runs')
            .select('championship_id,calendar_id,status,source_hash,calculated_at,last_error')
            .eq('championship_id', championshipId)
            .eq('calendar_id', calendarId)
            .maybeSingle();

        if (error) {
            console.error('Error fetching standings run:', error);
            return null;
        }

        if (!data) return null;

        let stage = data.status === 'completed' ? 'completed' : null;
        const hashStr = String(data.source_hash || '');
        if (hashStr.startsWith('partial_qualifying:')) {
            stage = 'partial_qualifying';
        } else if (hashStr.startsWith('partial_sprint:')) {
            stage = 'partial_sprint';
        } else if (hashStr.startsWith('completed:')) {
            stage = 'completed';
        }

        return {
            ...data,
            stage
        };
    } catch (err) {
        console.error('Unexpected error fetching standings run:', err);
        return null;
    }
}

async function syncBetOutcomes(championshipId, calendarId, sprintBets, raceBets, motogpResults, scoringContext) {
    try {
        const modifiedAt = formatSqlTimestamp(
            new Date(),
            normalizeTimeZone(scoringContext?.timeZone || DEFAULT_CHAMPIONSHIP_TIMEZONE)
        );
        const resultByRider = new Map(motogpResults.map(result => [normalizeEntityId(result.rider_id), result]));

        const sprintUpdates = (sprintBets || []).map(bet => {
            if (!scoringContext?.sprintSettled) {
                return {
                    id: bet.id,
                    outcome: null,
                    modified_at: modifiedAt
                };
            }
            const actual = resultByRider.get(normalizeEntityId(bet.rider_id));
            return {
                id: bet.id,
                outcome: isSuccessfulBet(bet.position, actual?.sprint_position) ? 'true' : 'false',
                modified_at: modifiedAt
            };
        });

        const raceUpdates = (raceBets || []).map(bet => {
            if (!scoringContext?.raceSettled) {
                return {
                    id: bet.id,
                    outcome: null,
                    modified_at: modifiedAt
                };
            }
            const actual = resultByRider.get(normalizeEntityId(bet.rider_id));
            return {
                id: bet.id,
                outcome: isSuccessfulBet(bet.position, actual?.race_position) ? 'true' : 'false',
                modified_at: modifiedAt
            };
        });

        if (sprintUpdates.length > 0) {
            for (const update of sprintUpdates) {
                const { error } = await db
                    .from('sprint_bets')
                    .update({
                        outcome: update.outcome,
                        modified_at: update.modified_at
                    })
                    .eq('id', update.id);

                if (error) {
                    console.error('Error syncing sprint bet outcomes:', error);
                    return false;
                }
            }
        }

        if (raceUpdates.length > 0) {
            for (const update of raceUpdates) {
                const { error } = await db
                    .from('race_bets')
                    .update({
                        outcome: update.outcome,
                        modified_at: update.modified_at
                    })
                    .eq('id', update.id);

                if (error) {
                    console.error('Error syncing race bet outcomes:', error);
                    return false;
                }
            }
        }

        console.log('[calcScores] bet outcomes synced', {
            championshipId,
            calendarId,
            scoringPhase: scoringContext,
            sprintBets: sprintUpdates.length,
            raceBets: raceUpdates.length
        });

        return true;
    } catch (err) {
        console.error('Unexpected error syncing bet outcomes:', err);
        return false;
    }
}

function isSuccessfulBet(selectedPosition, actualPosition) {
    if (!isPositiveNumber(selectedPosition) || !isPositiveNumber(actualPosition)) {
        return false;
    }
    const selected = Number(selectedPosition);
    const actual = Number(actualPosition);

    return selected === actual || selected === (actual - 1);
}

async function upsertStandingsEntries(entries) {
    try {
        const { error } = await db
            .from('standings_entries')
            .upsert(entries, { onConflict: 'championship_id,calendar_id,user_id' });

        if (error) {
            console.error('Error upserting standings entries:', error);
            return false;
        }

        return true;
    } catch (err) {
        console.error('Unexpected error upserting standings entries:', err);
        return false;
    }
}

async function upsertStandingsRun(run) {
    try {
        const { error } = await db
            .from('standings_runs')
            .upsert(run, { onConflict: 'championship_id,calendar_id' });

        if (error) {
            console.error('Error upserting standings run:', error);
            return false;
        }

        return true;
    } catch (err) {
        console.error('Unexpected error upserting standings run:', err);
        return false;
    }
}

async function deleteStandingsEntries(championshipId, calendarId) {
    try {
        const { error } = await db
            .from('standings_entries')
            .delete()
            .eq('championship_id', championshipId)
            .eq('calendar_id', calendarId);

        if (error) {
            console.error('Error deleting standings entries:', error);
            return false;
        }

        return true;
    } catch (err) {
        console.error('Unexpected error deleting standings entries:', err);
        return false;
    }
}

async function updateStandings(standingsUpdates) {
    try {
        const { error } = await db
            .from('standings')
            .upsert(standingsUpdates, { onConflict: 'championship_id,user_id' });

        if (error) {
            console.error('Error updating standings:', error);
            return false;
        }

        return true;
    } catch (err) {
        console.error('Unexpected error updating standings:', err);
        return false;
    }
}

module.exports = router;
module.exports.calculateAndPersistStandings = calculateAndPersistStandings;
module.exports.invalidateRaceScores = invalidateRaceScores;
module.exports.loadStandingsRun = loadStandingsRun;
