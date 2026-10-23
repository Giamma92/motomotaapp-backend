// routes/trophies.js
// Trophy history (hall of fame), user achievements and season finalization.
const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const authorizeRoles = require('../middleware/authorizeRoles');
const db = require('../models/db');
const { getMetadataMap } = require('../services/userMetaService');
const { notifyChampionshipUsers, createNotification } = require('../services/notificationService');

// First season really played with the app: older championships are test data
// and are excluded from statistics and badges.
const FIRST_SEASON_YEAR = Number(process.env.TROPHY_FIRST_YEAR || 2026);

const TROPHY_BY_POSITION = {
  1: 'season_champion',
  2: 'season_runner_up',
  3: 'season_third'
};

// Badge thresholds for bronze / silver / gold levels.
const BADGES = [
  { code: 'champion', icon: 'fa-trophy', thresholds: [1, 2, 3] },
  { code: 'gp_winner', icon: 'fa-flag-checkered', thresholds: [1, 3, 10] },
  { code: 'gp_podium', icon: 'fa-ranking-star', thresholds: [5, 15, 30] },
  { code: 'pole_man', icon: 'fa-stopwatch', thresholds: [1, 3, 10] },
  { code: 'sniper', icon: 'fa-bullseye', thresholds: [1, 3, 10] },
  { code: 'sprint_king', icon: 'fa-bolt', thresholds: [1, 3, 10] },
  { code: 'streak', icon: 'fa-fire', thresholds: [3, 5, 8] },
  { code: 'leader', icon: 'fa-crown', thresholds: [1, 5, 10] },
  { code: 'veteran', icon: 'fa-calendar-check', thresholds: [1, 3, 5] }
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchUsersMap(userIds) {
  const ids = [...new Set((userIds || []).filter(Boolean).map(String))];
  if (!ids.length) return new Map();
  const [{ data, error }, meta] = await Promise.all([
    db.from('users').select('id, first_name, last_name, profile_image').in('id', ids),
    getMetadataMap()
  ]);
  if (error) throw error;
  return new Map((data || []).map((u) => [String(u.id), { ...u, alias: meta?.[u.id]?.alias || null }]));
}

function userSnapshot(user, fallbackId) {
  return user
    ? { id: user.id, first_name: user.first_name, last_name: user.last_name, alias: user.alias || null, profile_image: user.profile_image || null }
    : { id: fallbackId, first_name: '', last_name: '', alias: null, profile_image: null };
}

/** Sorts standings rows and assigns a rank (ties share the same rank). */
function rankStandings(rows) {
  const sorted = [...(rows || [])].sort((a, b) => {
    const pa = a.position ?? Number.MAX_SAFE_INTEGER;
    const pb = b.position ?? Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;
    return Number(b.score || 0) - Number(a.score || 0);
  });
  let lastScore = null;
  let lastRank = 0;
  return sorted.map((row, index) => {
    let rank = row.position;
    if (rank == null) {
      rank = lastScore !== null && Number(row.score) === lastScore ? lastRank : index + 1;
    }
    lastScore = Number(row.score);
    lastRank = rank;
    return { ...row, rank };
  });
}

async function getChampionship(id) {
  const { data, error } = await db.from('championships').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

async function getRealChampionships() {
  const { data, error } = await db
    .from('championships')
    .select('*')
    .gte('year', FIRST_SEASON_YEAR)
    .order('year', { ascending: false });
  if (error) throw error;
  return data || [];
}

async function getStandings(championshipIds) {
  if (!championshipIds.length) return [];
  const { data, error } = await db
    .from('standings')
    .select('user_id, championship_id, position, score')
    .in('championship_id', championshipIds);
  if (error) throw error;
  return data || [];
}

async function getSeasonProgress(championshipId) {
  const [{ data: races, error: racesError }, { data: runs, error: runsError }] = await Promise.all([
    db.from('calendar').select('id, cancelled').eq('championship_id', championshipId),
    db.from('standings_runs').select('calendar_id, status').eq('championship_id', championshipId)
  ]);
  if (racesError) throw racesError;
  if (runsError) throw runsError;
  const activeRaces = (races || []).filter((r) => !r.cancelled);
  const completedIds = new Set((runs || []).filter((r) => r.status === 'completed').map((r) => Number(r.calendar_id)));
  const racesCompleted = activeRaces.filter((r) => completedIds.has(Number(r.id))).length;
  return {
    racesTotal: activeRaces.length,
    racesCompleted,
    seasonFinished: activeRaces.length > 0 && racesCompleted >= activeRaces.length
  };
}

async function resolveUserId(req, param) {
  if (param && param !== 'me') return String(param);
  const { data, error } = await db.from('users').select('id').eq('profile_id', req.userId).maybeSingle();
  if (error) throw error;
  return data?.id || req.username;
}

function badgeLevel(value, thresholds) {
  let level = 0;
  thresholds.forEach((t, i) => { if (value >= t) level = i + 1; });
  return level;
}

/**
 * Computes per-race statistics for a user across the given championships,
 * based on standings_entries (only completed, non-cancelled races).
 */
async function computeRaceStats(userId, championships) {
  const champIds = championships.map((c) => c.id);
  const empty = {
    racesPlayed: 0, totalPoints: 0, bestRace: null, gpWins: 0, gpPodiums: 0,
    poles: 0, bestRaceBets: 0, bestSprintBets: 0, maxTopThreeStreak: 0, racesAsLeader: 0
  };
  if (!champIds.length) return empty;

  const [{ data: entries, error: entriesError }, { data: calendars, error: calError }, { data: runs, error: runsError }] = await Promise.all([
    db.from('standings_entries')
      .select('championship_id, calendar_id, user_id, qualifying_score, race_score, sprint_bet_score, race_bet_score, score')
      .in('championship_id', champIds),
    db.from('calendar').select('id, championship_id, race_order, cancelled, race_id(name, country)').in('championship_id', champIds),
    db.from('standings_runs').select('calendar_id, status').in('championship_id', champIds)
  ]);
  if (entriesError) throw entriesError;
  if (calError) throw calError;
  if (runsError) throw runsError;

  const runStatus = new Map((runs || []).map((r) => [Number(r.calendar_id), r.status]));
  const calendarMap = new Map((calendars || []).map((c) => [Number(c.id), c]));

  // Group entries by race
  const byRace = new Map();
  for (const entry of entries || []) {
    const calId = Number(entry.calendar_id);
    const cal = calendarMap.get(calId);
    if (!cal || cal.cancelled) continue;
    const status = runStatus.get(calId) || 'completed';
    if (status !== 'completed') continue;
    if (!byRace.has(calId)) byRace.set(calId, []);
    byRace.get(calId).push(entry);
  }

  const stats = { ...empty };
  const races = [...byRace.entries()]
    .map(([calId, list]) => ({ cal: calendarMap.get(calId), list }))
    .sort((a, b) => {
      if (a.cal.championship_id !== b.cal.championship_id) {
        const ya = championships.find((c) => c.id === a.cal.championship_id)?.year || 0;
        const yb = championships.find((c) => c.id === b.cal.championship_id)?.year || 0;
        return ya - yb;
      }
      return Number(a.cal.race_order || 0) - Number(b.cal.race_order || 0);
    });

  const cumulative = new Map(); // championship_id -> Map(user -> points)
  let streak = 0;

  for (const { cal, list } of races) {
    const champTotals = cumulative.get(cal.championship_id) || new Map();
    cumulative.set(cal.championship_id, champTotals);
    for (const e of list) {
      champTotals.set(e.user_id, (champTotals.get(e.user_id) || 0) + Number(e.score || 0));
    }

    const mine = list.find((e) => String(e.user_id) === String(userId));
    if (!mine) { streak = 0; continue; }

    stats.racesPlayed += 1;
    stats.totalPoints += Number(mine.score || 0);
    if (!stats.bestRace || Number(mine.score) > stats.bestRace.score) {
      stats.bestRace = {
        score: Number(mine.score || 0),
        calendar_id: cal.id,
        name: cal.race_id?.name || null,
        country: cal.race_id?.country || null,
        year: championships.find((c) => c.id === cal.championship_id)?.year || null
      };
    }

    const max = (field) => Math.max(...list.map((e) => Number(e[field] || 0)));
    const scoreRank = 1 + list.filter((e) => Number(e.score || 0) > Number(mine.score || 0)).length;
    if (scoreRank === 1) stats.gpWins += 1;
    if (scoreRank <= 3) { stats.gpPodiums += 1; streak += 1; } else { streak = 0; }
    stats.maxTopThreeStreak = Math.max(stats.maxTopThreeStreak, streak);

    const bestQ = max('qualifying_score');
    if (bestQ > 0 && Number(mine.qualifying_score || 0) === bestQ) stats.poles += 1;
    const bestRB = max('race_bet_score');
    if (bestRB > 0 && Number(mine.race_bet_score || 0) === bestRB) stats.bestRaceBets += 1;
    const bestSB = max('sprint_bet_score');
    if (bestSB > 0 && Number(mine.sprint_bet_score || 0) === bestSB) stats.bestSprintBets += 1;

    const leaderPoints = Math.max(...champTotals.values());
    if ((champTotals.get(mine.user_id) || 0) === leaderPoints) stats.racesAsLeader += 1;
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Public (authenticated) endpoints
// ---------------------------------------------------------------------------

/**
 * GET /trophies/history
 * Global trophy history: podium per completed season, medal table and
 * the live podium of the season in progress.
 */
router.get('/trophies/history', authMiddleware, async (req, res) => {
  try {
    const championships = await getRealChampionships();
    const completed = championships.filter((c) => c.completed_at);
    const current = championships.find((c) => !c.completed_at && c.is_active) ||
      championships.find((c) => !c.completed_at) || null;

    const champIds = championships.map((c) => c.id);
    const [standings, { data: trophies, error: trophiesError }] = await Promise.all([
      getStandings(champIds),
      champIds.length
        ? db.from('user_trophies').select('*').in('championship_id', champIds)
        : Promise.resolve({ data: [], error: null })
    ]);
    if (trophiesError) throw trophiesError;

    const usersMap = await fetchUsersMap([
      ...standings.map((s) => s.user_id),
      ...(trophies || []).map((t) => t.user_id)
    ]);

    const seasons = completed.map((champ) => {
      const rows = rankStandings(standings.filter((s) => s.championship_id === champ.id));
      const champTrophies = (trophies || []).filter((t) => t.championship_id === champ.id);
      return {
        championship: { id: champ.id, year: champ.year, description: champ.description, completed_at: champ.completed_at },
        participants: rows.length,
        podium: champTrophies
          .filter((t) => t.trophy_code !== 'special')
          .sort((a, b) => Number(a.final_position || 0) - Number(b.final_position || 0))
          .map((t) => ({
            id: t.id,
            trophy_code: t.trophy_code,
            position: t.final_position,
            score: Number(t.final_score || 0),
            user: userSnapshot(usersMap.get(String(t.user_id)), t.user_id)
          })),
        specials: champTrophies
          .filter((t) => t.trophy_code === 'special')
          .map((t) => ({ id: t.id, title: t.title, user: userSnapshot(usersMap.get(String(t.user_id)), t.user_id) })),
        standings: rows.map((r) => ({
          position: r.rank,
          score: Number(r.score || 0),
          user: userSnapshot(usersMap.get(String(r.user_id)), r.user_id)
        }))
      };
    });

    // Medal table
    const medals = new Map();
    const ensure = (userId) => {
      const key = String(userId);
      if (!medals.has(key)) {
        medals.set(key, { user: userSnapshot(usersMap.get(key), key), gold: 0, silver: 0, bronze: 0, specials: 0, seasons: 0, bestPosition: null });
      }
      return medals.get(key);
    };
    for (const season of seasons) {
      for (const row of season.standings) {
        const m = ensure(row.user.id);
        m.seasons += 1;
        m.bestPosition = m.bestPosition == null ? row.position : Math.min(m.bestPosition, row.position);
      }
      for (const p of season.podium) {
        const m = ensure(p.user.id);
        if (p.trophy_code === 'season_champion') m.gold += 1;
        if (p.trophy_code === 'season_runner_up') m.silver += 1;
        if (p.trophy_code === 'season_third') m.bronze += 1;
      }
      for (const s of season.specials) ensure(s.user.id).specials += 1;
    }
    const medalTable = [...medals.values()]
      .map((m) => ({ ...m, total: m.gold + m.silver + m.bronze }))
      .sort((a, b) => b.gold - a.gold || b.silver - a.silver || b.bronze - a.bronze || b.seasons - a.seasons);

    let currentSeason = null;
    if (current) {
      const rows = rankStandings(standings.filter((s) => s.championship_id === current.id));
      const progress = await getSeasonProgress(current.id);
      currentSeason = {
        championship: { id: current.id, year: current.year, description: current.description },
        participants: rows.length,
        ...progress,
        podium: rows.filter((r) => r.rank <= 3).map((r) => ({
          position: r.rank,
          score: Number(r.score || 0),
          user: userSnapshot(usersMap.get(String(r.user_id)), r.user_id)
        }))
      };
    }

    res.json({ firstYear: FIRST_SEASON_YEAR, seasons, medalTable, current: currentSeason });
  } catch (err) {
    console.error('Error fetching trophy history:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /achievements/:userId   (use "me" for the authenticated user)
 * Trophy cabinet, season history, badges and statistics of a user.
 */
router.get('/achievements/:userId', authMiddleware, async (req, res) => {
  try {
    const userId = await resolveUserId(req, req.params.userId);
    const usersMap = await fetchUsersMap([userId]);
    if (!usersMap.has(String(userId))) {
      return res.status(404).json({ error: 'User not found' });
    }

    const championships = await getRealChampionships();
    const champIds = championships.map((c) => c.id);
    const [standings, { data: trophies, error: trophiesError }] = await Promise.all([
      getStandings(champIds),
      db.from('user_trophies').select('*').eq('user_id', userId)
    ]);
    if (trophiesError) throw trophiesError;

    const seasons = championships
      .map((champ) => {
        const rows = rankStandings(standings.filter((s) => s.championship_id === champ.id));
        const mine = rows.find((r) => String(r.user_id) === String(userId));
        if (!mine) return null;
        return {
          championship_id: champ.id,
          year: champ.year,
          description: champ.description,
          completed: !!champ.completed_at,
          position: mine.rank,
          score: Number(mine.score || 0),
          participants: rows.length
        };
      })
      .filter(Boolean);

    const champYear = new Map(championships.map((c) => [c.id, c.year]));
    const allChampYears = new Map();
    const missingChampIds = [...new Set((trophies || []).map((t) => t.championship_id).filter((id) => !champYear.has(id)))];
    if (missingChampIds.length) {
      const { data } = await db.from('championships').select('id, year').in('id', missingChampIds);
      (data || []).forEach((c) => allChampYears.set(c.id, c.year));
    }
    const trophyList = (trophies || [])
      .map((t) => ({
        id: t.id,
        trophy_code: t.trophy_code,
        title: t.title,
        position: t.final_position,
        score: t.final_score != null ? Number(t.final_score) : null,
        championship_id: t.championship_id,
        year: champYear.get(t.championship_id) ?? allChampYears.get(t.championship_id) ?? null,
        awarded_at: t.awarded_at
      }))
      .sort((a, b) => (b.year || 0) - (a.year || 0) || (a.position || 9) - (b.position || 9));

    const raceStats = await computeRaceStats(userId, championships);
    const counts = {
      gold: trophyList.filter((t) => t.trophy_code === 'season_champion').length,
      silver: trophyList.filter((t) => t.trophy_code === 'season_runner_up').length,
      bronze: trophyList.filter((t) => t.trophy_code === 'season_third').length,
      specials: trophyList.filter((t) => t.trophy_code === 'special').length
    };

    const values = {
      champion: counts.gold,
      gp_winner: raceStats.gpWins,
      gp_podium: raceStats.gpPodiums,
      pole_man: raceStats.poles,
      sniper: raceStats.bestRaceBets,
      sprint_king: raceStats.bestSprintBets,
      streak: raceStats.maxTopThreeStreak,
      leader: raceStats.racesAsLeader,
      veteran: seasons.length
    };
    const badges = BADGES.map((b) => {
      const value = values[b.code] || 0;
      const level = badgeLevel(value, b.thresholds);
      return { code: b.code, icon: b.icon, value, level, thresholds: b.thresholds, next: b.thresholds[level] ?? null };
    });

    res.json({
      user: userSnapshot(usersMap.get(String(userId)), userId),
      counts,
      trophies: trophyList,
      seasons,
      badges,
      stats: {
        seasons: seasons.length,
        racesPlayed: raceStats.racesPlayed,
        totalPoints: raceStats.totalPoints,
        avgPoints: raceStats.racesPlayed ? Math.round((raceStats.totalPoints / raceStats.racesPlayed) * 10) / 10 : 0,
        bestRace: raceStats.bestRace,
        bestPosition: seasons.length ? Math.min(...seasons.map((s) => s.position)) : null
      }
    });
  } catch (err) {
    console.error('Error fetching achievements:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Admin endpoints
// ---------------------------------------------------------------------------

async function buildPodiumPreview(championshipId) {
  const rows = rankStandings(await getStandings([championshipId]));
  const usersMap = await fetchUsersMap(rows.map((r) => r.user_id));
  return {
    participants: rows.length,
    podium: rows.filter((r) => r.rank <= 3).map((r) => ({
      position: r.rank,
      score: Number(r.score || 0),
      trophy_code: TROPHY_BY_POSITION[r.rank],
      user: userSnapshot(usersMap.get(String(r.user_id)), r.user_id)
    }))
  };
}

/**
 * GET /championships/:id/finalize
 * Preview of the podium that would be awarded and season progress.
 */
router.get('/championships/:id/finalize', authMiddleware, authorizeRoles('Admin'), async (req, res) => {
  try {
    const championship = await getChampionship(req.params.id);
    if (!championship) return res.status(404).json({ error: 'Championship not found' });
    const [preview, progress] = await Promise.all([
      buildPodiumPreview(championship.id),
      getSeasonProgress(championship.id)
    ]);
    res.json({
      championship,
      completed: !!championship.completed_at,
      countsForHistory: championship.year >= FIRST_SEASON_YEAR,
      ...progress,
      ...preview
    });
  } catch (err) {
    console.error('Error building finalize preview:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /championships/:id/finalize
 * Snapshots the final podium into user_trophies and marks the season as completed.
 * Body: { notify?: boolean }
 */
router.post('/championships/:id/finalize', authMiddleware, authorizeRoles('Admin'), async (req, res) => {
  try {
    const championship = await getChampionship(req.params.id);
    if (!championship) return res.status(404).json({ error: 'Championship not found' });
    if (championship.completed_at) {
      return res.status(409).json({ error: 'Championship already finalized' });
    }

    const { podium, participants } = await buildPodiumPreview(championship.id);
    if (!podium.length) {
      return res.status(400).json({ error: 'No standings available for this championship' });
    }

    const rows = podium.map((p) => ({
      user_id: p.user.id,
      championship_id: championship.id,
      trophy_code: p.trophy_code,
      final_position: p.position,
      final_score: p.score,
      awarded_by: req.username,
      metadata: {
        first_name: p.user.first_name,
        last_name: p.user.last_name,
        alias: p.user.alias,
        participants,
        year: championship.year
      }
    }));

    const { data: inserted, error: insertError } = await db.from('user_trophies').insert(rows).select();
    if (insertError) throw insertError;

    const completedAt = new Date().toISOString();
    const { error: updateError } = await db
      .from('championships')
      .update({ completed_at: completedAt })
      .eq('id', championship.id);
    if (updateError) {
      await db.from('user_trophies').delete().in('id', (inserted || []).map((t) => t.id));
      throw updateError;
    }

    if (req.body?.notify !== false) {
      const champion = podium.find((p) => p.position === 1);
      const championName = champion
        ? (champion.user.alias || `${champion.user.first_name} ${champion.user.last_name}`.trim())
        : '';
      try {
        await notifyChampionshipUsers({
          championshipId: championship.id,
          category: 'standing_change',
          title: `🏆 ${championName} è Campione ${championship.year}!`,
          body: 'La stagione è conclusa: scopri il podio nella Trophy History.',
          type: 'success',
          link: '/trophies'
        });
        for (const p of podium) {
          await createNotification({
            userId: p.user.id,
            championshipId: championship.id,
            category: 'standing_change',
            title: p.position === 1 ? '🥇 Sei il Campione!' : p.position === 2 ? '🥈 Secondo posto!' : '🥉 Terzo posto!',
            body: `Hai conquistato un trofeo nella stagione ${championship.year}. Guardalo nella tua bacheca!`,
            type: 'success',
            link: '/achievements'
          });
        }
      } catch (notifyErr) {
        console.error('Failed to send trophy notifications:', notifyErr);
      }
    }

    res.status(201).json({ championship: { ...championship, completed_at: completedAt }, trophies: inserted });
  } catch (err) {
    console.error('Error finalizing championship:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /championships/:id/finalize
 * Re-opens a season: removes the awarded season trophies.
 */
router.delete('/championships/:id/finalize', authMiddleware, authorizeRoles('Admin'), async (req, res) => {
  try {
    const championship = await getChampionship(req.params.id);
    if (!championship) return res.status(404).json({ error: 'Championship not found' });

    const { error: delError } = await db
      .from('user_trophies')
      .delete()
      .eq('championship_id', championship.id)
      .neq('trophy_code', 'special');
    if (delError) throw delError;

    const { error: updateError } = await db
      .from('championships')
      .update({ completed_at: null })
      .eq('id', championship.id);
    if (updateError) throw updateError;

    res.json({ ok: true });
  } catch (err) {
    console.error('Error re-opening championship:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /trophies/special
 * Manually awards a special trophy. Body: { user_id, championship_id, title }
 */
router.post('/trophies/special', authMiddleware, authorizeRoles('Admin'), async (req, res) => {
  const { user_id, championship_id, title } = req.body || {};
  if (!user_id || !championship_id || !title?.trim()) {
    return res.status(400).json({ error: 'user_id, championship_id and title are required' });
  }
  try {
    const { data, error } = await db
      .from('user_trophies')
      .insert({ user_id, championship_id, trophy_code: 'special', title: title.trim(), awarded_by: req.username })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    console.error('Error awarding special trophy:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /trophies/:id
 * Removes a single trophy (admin).
 */
router.delete('/trophies/:id', authMiddleware, authorizeRoles('Admin'), async (req, res) => {
  try {
    const { error } = await db.from('user_trophies').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('Error deleting trophy:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
