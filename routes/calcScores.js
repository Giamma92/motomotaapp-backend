const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const authMiddleware = require('../middleware/authMiddleware');
const authorizeRoles = require('../middleware/authorizeRoles');
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

    const ensuredLineups = await ensureMissingLineupsForScoring(
        championshipId,
        calendarId,
        fantasyTeams,
        initialLineups,
        scoringContext?.timeZone
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
        scoringContext
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
        scoringContext
    });

    const results = calculateRaceScores({
        championshipId,
        calendarId,
        fantasyTeams,
        lineups: ensuredLineups,
        raceBets,
        sprintBets,
        motogpResults,
        scoringContext
    });

    const sourceHash = computeSourceHash({
        championshipId,
        calendarId,
        fantasyTeams,
        lineups: ensuredLineups,
        raceBets,
        sprintBets,
        motogpResults,
        scoringContext
    });

    if (!force && existingRun?.status === 'completed' && existingRun.source_hash === sourceHash) {
        console.log(`Standings already up to date for championship ${championshipId}, calendar ${calendarId}`);
        return { ok: true, results, scoringContext };
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
        source_hash: sourceHash,
        calculated_at: new Date().toISOString()
    }));

    const runPayload = {
        championship_id: championshipId,
        calendar_id: calendarId,
        status: 'running',
        source_hash: sourceHash,
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
    const standingsUpdated = await updateStandings(aggregatedStandings);
    if (!standingsUpdated) {
        await upsertStandingsRun({
            ...runPayload,
            status: 'failed',
            last_error: 'Failed to update standings snapshot'
        });
        return { ok: false, status: 500, error: 'Fail to update standings snapshot' };
    }

    await upsertStandingsRun({
        ...runPayload,
        status: 'completed',
        last_error: null
    });

    return { ok: true, results, scoringContext };
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
            ? Number(qualifyingResult?.qualifying_points || 0)
            : 0;
        const raceScore = scoringContext.raceSettled
            ? Number(raceResult?.race_points || 0)
            : 0;
        const sprintBetScore = Number(sprintBet?.points || 0);
        const raceBetScore = Number(raceBet?.points || 0);

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
                raceBetScore
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
            own_score: ownScore,
            score: ownScore
        };
    });

    const eligibleScores = rawResults
        .filter(result => !result.uses_fallback_score)
        .map(result => Number(result.own_score || 0));

    const fallbackScore = eligibleScores.length > 0 ? Math.min(...eligibleScores) : 0;

    return rawResults.map(result => {
        if (!result.uses_fallback_score) {
            return {
                ...result,
                score: result.own_score
            };
        }

        return {
            ...result,
            qualifying_score: 0,
            race_score: 0,
            sprint_bet_score: 0,
            sprint_bet_delta: 0,
            race_bet_score: 0,
            race_bet_delta: 0,
            score: fallbackScore
        };
    });
}

function calculateBetDelta(selectedPosition, actualPosition, betScore) {
    const selected = Number(selectedPosition);
    const actual = Number(actualPosition);
    const score = Number(betScore || 0);

    if (!Number.isFinite(selected) || !Number.isFinite(score) || score === 0) {
        return 0;
    }
    if (!Number.isFinite(actual)) {
        return 0;
    }
    if (Number.isFinite(actual) && (selected === actual || selected === (actual - 1))) {
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
        qualifying_points: result.qualifying_points,
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
                    qualifying_points: qualifyingResult.qualifying_points
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

function normalizeForHash(value) {
    if (Array.isArray(value)) {
        return value
            .map(item => normalizeForHash(item))
            .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    }

    if (value && typeof value === 'object') {
        return Object.keys(value)
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
                .select('id,event_date,qualifications_time,sprint_time,event_time')
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
        const missingUserIds = (fantasyTeams || [])
            .map(team => normalizeUserId(team.user_id?.id))
            .filter(userId => userId && !existingUserIds.has(userId));

        if (missingUserIds.length === 0) {
            return currentLineups;
        }

        const previousRaceId = await loadPreviousCalendarId(championshipId, calendarId);
        if (!previousRaceId) {
            return currentLineups;
        }

        const { data: previousLineups, error: previousLineupsError } = await db
            .from('lineups')
            .select('user_id,qualifying_rider_id,race_rider_id')
            .eq('championship_id', championshipId)
            .eq('calendar_id', previousRaceId)
            .in('user_id', missingUserIds);

        if (previousLineupsError) {
            console.error('Error loading previous lineups for fallback scoring:', previousLineupsError);
            return null;
        }

        const rows = (previousLineups || []).map(lineup => ({
            championship_id: championshipId,
            calendar_id: calendarId,
            user_id: lineup.user_id,
            qualifying_rider_id: lineup.qualifying_rider_id,
            race_rider_id: lineup.race_rider_id,
            modified_at: modifiedAt,
            automatically_inserted: true
        }));

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

        return data || null;
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

        const sprintUpdates = scoringContext?.sprintSettled ? (sprintBets || []).map(bet => {
            const actual = resultByRider.get(normalizeEntityId(bet.rider_id));
            return {
                id: bet.id,
                outcome: isSuccessfulBet(bet.position, actual?.sprint_position) ? 'true' : 'false',
                modified_at: modifiedAt
            };
        }) : [];

        const raceUpdates = scoringContext?.raceSettled ? (raceBets || []).map(bet => {
            const actual = resultByRider.get(normalizeEntityId(bet.rider_id));
            return {
                id: bet.id,
                outcome: isSuccessfulBet(bet.position, actual?.race_position) ? 'true' : 'false',
                modified_at: modifiedAt
            };
        }) : [];

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
    const selected = Number(selectedPosition);
    const actual = Number(actualPosition);

    if (!Number.isFinite(selected) || !Number.isFinite(actual)) {
        return false;
    }

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
