// routes/lineups.js
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const authMiddleware = require('../middleware/authMiddleware');

/**
 * GET /api/championship/:championship_id/lineups/:race_id
 * Gets lineup data for a specific race and user
 */
router.get('/championship/:championship_id/lineups/:race_id', authMiddleware, async (req, res) => {
  const { championship_id, race_id } = req.params;
  const user_id = req.username;
  const allCalendar = req.query.allCalendar == 'true'

  try {
    let query = db
      .from('lineups')
      .select(`id,
               race_rider_id(id,first_name, last_name, number),
               qualifying_rider_id(id,first_name, last_name, number),
               championship_id,
               user_id,
               calendar_id`)
      .eq('championship_id', championship_id)
      .eq('user_id', user_id);

    if (!allCalendar) {
      query = query.eq('calendar_id', race_id);
    }

    const { data, error } = await query.select();

    if (error) {
      console.error("Error fetching lineup:", error);
      return res.status(500).json({ error: error.message });
    }
    
    if (data.length === 0) {
      return res.status(404).json({ error: "Lineup not found" });
    }

    res.status(200).json(data[0]);
  } catch (err) {
    console.error("Unexpected error in lineups endpoint:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * PUT /api/championship/:championship_id/lineups
 * Upserts a lineup record (insert or update if exists)
 * Expected body: { calendar_id, race_rider_id, qualifying_rider_id }
 */
router.put('/championship/:championship_id/lineups', authMiddleware, async (req, res) => {
  const championshipId = req.params.championship_id;
  const userId = req.username; // attached by authMiddleware
  const { calendar_id, race_rider_id, qualifying_rider_id } = req.body;
  
  try {
    // Get the formation_limit_driver from championship configuration
    const { data: configData, error: configError } = await db
      .from('configuration')
      .select('formation_limit_driver')
      .eq('championship_id', championshipId)
      .single();

    if (configError) {
      console.error("Error fetching championship configuration:", configError);
      return res.status(500).json({ error: configError.message });
    }

    if (!configData || !configData.formation_limit_driver) {
      console.error("No formation_limit_driver found in championship configuration");
      return res.status(500).json({ error: "Championship configuration not found" });
    }

    const formationLimit = configData.formation_limit_driver;

    // Check if qualifying rider and race rider are different
    if (qualifying_rider_id === race_rider_id) {
      return res.status(400).json({ 
        error: "Invalid lineup configuration", 
        details: {
          message: "Qualifying rider and race rider must be different"
        }
      });
    }

    // Get all lineups for the current championship to count rider appearances
    const { data: allLineups, error: lineupsError } = await db
      .from('lineups')
      .select('race_rider_id, qualifying_rider_id')
      .eq('championship_id', championshipId)
      .eq('user_id', userId);

    if (lineupsError) {
      console.error("Error fetching existing lineups:", lineupsError);
      return res.status(500).json({ error: lineupsError.message });
    }

    // Count how many times each rider appears in qualifying and race positions
    const riderCounts = new Map();

    // Count existing lineups
    allLineups.forEach(lineup => {
      // Count qualifying rider
      if (lineup.qualifying_rider_id) {
        const currentCount = riderCounts.get(lineup.qualifying_rider_id) || 0;
        riderCounts.set(lineup.qualifying_rider_id, currentCount + 1);
      }
      
      // Count race rider
      if (lineup.race_rider_id) {
        const currentCount = riderCounts.get(lineup.race_rider_id) || 0;
        riderCounts.set(lineup.race_rider_id, currentCount + 1);
      }
    });

    // Add the new lineup riders to the count
    if (qualifying_rider_id) {
      const currentCount = riderCounts.get(qualifying_rider_id) || 0;
      riderCounts.set(qualifying_rider_id, currentCount + 1);
    }
    
    if (race_rider_id) {
      const currentCount = riderCounts.get(race_rider_id) || 0;
      riderCounts.set(race_rider_id, currentCount + 1);
    }

    // Check if any rider exceeds the formation limit
    const exceededRiders = [];
    riderCounts.forEach((count, riderId) => {
      if (count > formationLimit) {
        exceededRiders.push({ riderId, count });
      }
    });

    if (exceededRiders.length > 0) {
      return res.status(400).json({ 
        error: "Formation limit exceeded", 
        details: {
          exceededRiders,
          formationLimit,
          message: `The following riders exceed the formation limit of ${formationLimit}: ${exceededRiders.map(r => `Rider ${r.riderId} (${r.count} times)`).join(', ')}`
        }
      });
    }

    // Proceed with the upsert if validation passes
    const { data, error } = await db
      .from('lineups')
      .upsert({
          championship_id: championshipId,
          calendar_id: calendar_id,
          user_id: userId,
          race_rider_id: race_rider_id,
          qualifying_rider_id: qualifying_rider_id,
          modified_at: new Date().toISOString()
      }, { onConflict: 'championship_id, user_id, calendar_id' })
      .select();
      
    if (error) {
      console.error("Error inserting lineup:", error);
      return res.status(500).json({ error: error.message });
    }
    
    res.status(201).json(data[0]);
  } catch (err) {
    console.error("Unexpected error in lineups endpoint:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
