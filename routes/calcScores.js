const express = require('express');
const router = express.Router();
const db = require('../models/db');
const authMiddleware = require('../middleware/authMiddleware');
const authorizeRoles = require('../middleware/authorizeRoles');

router.get('/championship/:id/calendar/:calendar_id/calc-scores/', authMiddleware, authorizeRoles('Admin'), async (req, res) => {
    const championship_id = req.params.id;
    const calendar_id = req.params.calendar_id;
    const results = [];

    // Load data with error handling
    const [fantasyTeams, lineups, raceBets, sprintBets, motogpResults, standings] = await Promise.all([
        loadFantasyTeams(championship_id),
        loadLineups(championship_id, calendar_id),
        loadRaceBets(championship_id, calendar_id),
        loadSprintBets(championship_id, calendar_id),
        loadMotoGPResults(championship_id, calendar_id),
        loadStandings(championship_id)
    ]);

    // Check for errors in any of the data loads
    if (!fantasyTeams || !Array.isArray(fantasyTeams)) {
        return res.status(500).json({ error: 'Fail to load fantasy teams' });
    }
    if (!lineups) {
        return res.status(500).json({ error: 'Fail to load lineups' });
    }
    if (!raceBets) {
        return res.status(500).json({ error: 'Fail to load race bets' });
    }
    if (!sprintBets) {
        return res.status(500).json({ error: 'Fail to load sprint bets' });
    }
    if (!motogpResults) {
        return res.status(500).json({ error: 'Fail to load motogp results' });
    }

    // Process fantasy teams only if they were loaded successfully
    fantasyTeams.forEach(team => {
        const lineup = lineups.find(lineup => lineup.user_id === team.user_id.id);
        const raceBet = raceBets.find(raceBet => raceBet.user_id === team.user_id.id);
        const sprintBet = sprintBets.find(sprintBet => sprintBet.user_id === team.user_id.id);

        const qualifying_rider_id = lineup?.qualifying_rider_id?.id;
        const race_rider_id = lineup?.race_rider_id?.id;
        const sprint_bet_rider_id = sprintBet?.rider_id;
        const race_bet_rider_id = raceBet?.rider_id;

        const qualifyingResult = motogpResults?.find(result => result.rider_id === qualifying_rider_id);
        const raceResult = motogpResults?.find(result => result.rider_id === race_rider_id);
        const sprintBetResult = motogpResults?.find(result => result.rider_id === sprint_bet_rider_id);
        const raceBetResult = motogpResults?.find(result => result.rider_id === race_bet_rider_id);

        const qualifyingScore = qualifyingResult?.qualifying_points || 0;
        const raceScore = raceResult?.race_points || 0;
        const raceBetScore = raceBet?.points || 0;
        const sprintBetScore = sprintBet?.points || 0;

        let totalScore = qualifyingScore + raceScore;

        if (+sprintBet?.position == +sprintBetResult?.sprint_position ||
            +sprintBet?.position == (+sprintBetResult?.sprint_position - 1)
        ) {
            totalScore += sprintBetScore;
        } else if (!!sprintBet && 
            +sprintBet.position != +sprintBetResult?.sprint_position &&
            +sprintBet.position != (+sprintBetResult?.sprint_position - 1)
        ) {
            totalScore -= Math.floor(sprintBetScore/2);
        }

        if (+raceBet?.position == +raceBetResult?.race_position ||
            +raceBet?.position == (+raceBetResult?.race_position - 1)
        ) {
            totalScore += raceBetScore;
        } else if (!!raceBet && 
            +raceBet.position != +raceBetResult?.race_position &&
            +raceBet.position != (+raceBetResult?.race_position - 1)
        ) {
            totalScore -= Math.floor(raceBetScore/2);
        }

        results.push({
            user_id: team.user_id.id,
            first_name: team.user_id.first_name + ' ' + team.user_id.last_name,
            team_name: team.name,
            score: totalScore
        });
    });

    //update results in standings table
    const updatedStandings = results.map(result => {
        const standing = standings.find(s => s.user_id.id === result.user_id);
        if(standing){
            return {
                user_id: result.user_id,
                championship_id: championship_id,
                position: standing.position,
                score: standing.score + result.score
            }
        }
    });
    const sortedStandings = updatedStandings.sort((a,b) => b.score - a.score);
    const standingsWithNewPositions = sortedStandings.map((standing, index) => ({
        ...standing,
        position: index + 1,
    }));
    const finalStandingsUpdates = standingsWithNewPositions.map(standing => ({
        user_id: standing.user_id,
        championship_id: standing.championship_id,
        position: standing.position,
        score: standing.score,
        update_calendar: calendar_id
    }));

    if(finalStandingsUpdates.length > 0){

        let shouldUpdate = false;
        standings.forEach(standing => {
            if(standing?.update_calendar?.id != calendar_id){
                shouldUpdate = true;
            }
        });

        if (shouldUpdate) {
            console.log("Update standings!");
            data = await updateStandings(finalStandingsUpdates);
            console.log("New standings: ", data);
        } else {
            console.log("Update not needed!");
        }
        
        console.log("New standings: ", finalStandingsUpdates);
    }

    res.json(results);
});

async function loadFantasyTeams(championshipId) {
    try {
        console.log(`⌛ Waiting for load fantasy teams (championship: ${championshipId})...`);
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
            console.error("❌ Error fetching fantasy teams:", error);
            return {};
        }
        console.error("✅ Fantasy teams found!:", data.length);
        return data;

    } catch (err) {
        console.error("❌ Unexpected error:", err);
        return {};
    }
}

async function loadLineups(championshipId, calendarId) {
    try {
        const { data, error } = await db
            .from('lineups')
            .select(`id,
                    race_rider_id(id,first_name, last_name, number),
                    qualifying_rider_id(id,first_name, last_name, number),
                    championship_id,
                    user_id,
                    calendar_id`)
            .eq('championship_id', championshipId)
            .eq('calendar_id', calendarId);

        if (error) {
            console.log("❌ Error fetching lineup", error);
            return null;
        }

        console.log("✅ Lineups results found!", data.length);
        return data;

    } catch (err) {
        console.error("❌ Unexpected error in lineups endpoint:", err);
        return null;
    }
}

async function loadRaceBets(championshipId, calendarId) {
    try {
        console.log(`⌛ Waiting for load race bets (championship: ${championshipId}, calendar: ${calendarId})...`);
        const { data, error } = await db
            .from('race_bets')
            .select(`
                id,
                user_id,
                championship_id,
                calendar_id,
                rider_id,
                position,
                points
            `)
            .eq('championship_id', championshipId)
            .eq('calendar_id', calendarId);

        if (error) {
            console.error('❌ Error fetching bets:', error);
            return null;
        }
        console.log("✅ Race bets found!", data.length);
        return data;
    } catch (err) {
        console.error('❌ Unexpected error fetching bets:', err);
        return null;
    }
}

async function loadSprintBets(championshipId, calendarId) {
    try {
        console.log(`⌛ Waiting for load sprint bets (championship: ${championshipId}, calendar: ${calendarId})...`);
        const { data, error } = await db
            .from('sprint_bets')
            .select(`
                id,
                user_id,
                championship_id,
                calendar_id,
                rider_id,
                position,
                points
            `)
            .eq('championship_id', championshipId)
            .eq('calendar_id', calendarId);

        if (error) {
            console.error('❌ Error fetching sprint bets:', error);
            return null;
        }
        console.log("✅ Sprint Bets found!", data.length);
        return data;
    } catch (err) {
        console.error('❌ Unexpected error fetching sprint bets:', err);
        return null;
    }
}

async function loadMotoGPResults(championshipId, calendarId) {
    try {
        console.log(`⌛ Waiting for load motogp results (championship: ${championshipId}, calendar: ${calendarId})...`);
        const { data, error } = await db
            .from('motogp_results')
            .select(`
                id,
                rider_id,
                championship_id,
                calendar_id,
                qualifying_position,
                qualifying_points,
                sprint_position,
                sprint_points,
                race_position,
                race_points
            `)
            .eq('championship_id', championshipId)
            .eq('calendar_id', calendarId);

        if (error) {
            console.error('❌ Error fetching motogp results:', error);
            return null;
        }
        console.log("✅ Moto gp results found!", data.length);
        return data;
    } catch (err) {
        console.error('❌ Unexpected error fetching motogp results:', err);
        return null;
    }
}

async function loadStandings(championshipId) {
    try {
        console.log(`⌛ Waiting for load standings (championship: ${championshipId})...`);
        const { data, error } = await db
            .from('standings')
            .select(`
                id,
                user_id(id, email, first_name, last_name),
                championship_id,
                position,
                score,
                update_calendar(id)
            `)
            .eq('championship_id', championshipId)
            .order('position', { ascending: false }); // Order by position descending

        if (error) {
            console.error("❌ Error fetching standings:", error);
            return null;
        }
        console.log("✅ Standings loaded successfully!", data.length);
        return data;

    } catch (err) {
        console.error("❌ Unexpected error:", err);
        return null;
    }
}

async function updateStandings(standingsUpdates) {
    try {
        console.log("⌛ Updating standings...");
        const { data, error } = await db
            .from('standings')
            .upsert(standingsUpdates, { onConflict: 'championship_id,user_id' });
        
        if (error) {
            console.error('❌ Error updating standings:', error);
            return null;
        }

        console.log("✅ Standings updated successfully!");
        return data;

    } catch(error){
        console.error("❌ Error updating standings:", error);
        return null;
    }
}

module.exports = router;