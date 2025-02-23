const puppeteer = require('puppeteer');

const express = require('express');
const router = express.Router();
const db = require('../models/db');
const authMiddleware = require('../middleware/authMiddleware');

const baseUrl = "https://www.motogp.com/it/gp-results";

// GET all riders (you might pre-populate this table)
router.get('/championship/:id/calendar/:calendar_id/motogp-results/', async (req, res) => {
    const championshipId = req.params.id;
    const championship = await loadChampionship(championshipId);

    if(!championship || !championship.year) 
        return res.status(500).json({ error: 'No championship or no year configured' });
    const year = championship.year
    
    const calendarId = req.params.calendar_id;
    const calendarRace = await loadCalendarRace(championshipId,calendarId);
    const calendarCountry = calendarRace?.race_id?.country ?? 'unknown';
    if (calendarCountry == 'unknown') 
        return res.status(500).json({ error: 'No calendar race found with provided id' });

    const url = `${baseUrl}/${year}/${calendarCountry}/motogp/rac/classification`;

    const data = await scrapeMotoGPResults(url);
    res.json(data);
});

async function loadChampionship(championshipId) {
    try {
        console.log(`⌛ Waiting for load championship (id: ${championshipId})...`);
        const { data, error } = await db
            .from('championships')
            .select('id,year')
            .eq('id', championshipId)
            .single();

        if (error) {
            console.error('Error fetching calendar row:', error);
            return {}
        }
        console.log("✅ Championship found!", data);
        return data;
    
    } catch (err) {
        console.error('Unexpected error fetching calendar row:', err);
        return {};
    }
}

async function loadCalendarRace(championshipId, raceId) {
    try {
        console.log(`⌛ Waiting for load calendar race (race_id: ${raceId}, championship_id: ${championshipId})...`);
        const { data, error } = await db
            .from('calendar')
            .select(`
                id,
                race_id(name,location,country)
                `)
            .eq('championship_id', championshipId)
            .eq('race_id', raceId)
            .single();

        if (error) {
            console.error('Error fetching calendar row:', error);
            return {};
        }

        console.log("✅ Calendar race found!", data);
        return data;

    } catch (err) {
        console.error('Unexpected error fetching calendar row:', err);
        return {};
    }
}

async function scrapeMotoGPResults(url) {
    let results = {};
    console.log("🚀 Launching Puppeteer...");
    const browser = await puppeteer.launch({ headless: "new", args: ['--no-sandbox', '--disable-setuid-sandbox'] }); 
    const page = await browser.newPage();

    try {
        console.log(`🌍 Navigating to ${url}...`);
        const response = await page.goto(url, { waitUntil: 'domcontentloaded' });

        console.log("⌛ Waiting for content to load...");
        await new Promise(resolve => setTimeout(resolve, 5000)); // Wait longer in case of JavaScript rendering

        // Scroll down to force content loading
        console.log("🔽 Scrolling to load all content...");
        await page.evaluate(() => window.scrollBy(0, window.innerHeight));
        await new Promise(resolve => setTimeout(resolve, 3000));

        // ✅ 1. Check HTTP Status
        if (![200, 202].includes(response.status())) {
            console.log(`❌ Page load failed! HTTP Status: ${response.status()}`);
            return;
        }

        // ✅ 2. Check Final URL (Detect Redirects)
        const finalUrl = page.url();
        if (finalUrl !== url) {
            console.log(`❌ Redirect detected! Expected ${url}, but landed on ${finalUrl}`);
            return;
        }

         // ✅ 3. Check if the page contains expected elements
        const pageTitle = await page.title();
        if (!pageTitle.includes("MotoGP")) {
            console.log("❌ Unexpected page title:", pageTitle);
            return;
        }

        // ✅ 4. Verify if the classification table exists
        const tableExists = await page.$('.results-table__table');
        if (!tableExists) {
            console.log("❌ Table still not found. Trying alternative methods...");
            
            // Screenshot to debug
            //await page.screenshot({ path: 'debug_screenshot.png', fullPage: true });
            //console.log("📸 Screenshot saved as 'debug_screenshot.png' to check what is loaded.");
            
            return;
        }
        console.log("✅ Classification table found!");

        // ✅ 5. Extract classification data
        results = await page.evaluate(() => {
            const rows = Array.from(document.querySelectorAll('.results-table__table tbody .results-table__body-row'));
            console.log(`📌 Found ${rows.length} rows in the classification table.`);
            
            return rows.map(row => {
                const positionEl = row.querySelector('.results-table__body-cell--pos');
                const pointsEl = row.querySelector('.results-table__body-cell--points');
                const riderNumberEl = row.querySelector('.results-table__body-cell--number');
                const riderNameEl = row.querySelector('.results-table__body-cell--full-name');
                const teamEl = row.querySelector('.results-table__body-cell--team');

                if (!riderNameEl) {
                    console.log("⚠️ Skipping a row: Rider name not found.");
                    return null;
                }

                return {
                    position: positionEl ? parseInt(positionEl.innerText.trim(), 10) : 0,
                    points: pointsEl ? parseInt(pointsEl.innerText.trim(), 10) : 0,
                    rider_number: riderNumberEl ? riderNumberEl.innerText.trim() : 'N/A',
                    rider_name: riderNameEl.innerText.trim(),
                    team: teamEl ? teamEl.innerText.trim() : 'Unknown Team'
                };
            }).filter(result => result !== null);
        });

        if (results.length === 0) {
            console.log("❌ No race results found. The page structure might have changed.");
        } else {
            console.log("✅ Successfully scraped MotoGP results:");
            console.table(results);

            // ✅ 6. Save to Supabase
            //await saveToSupabase(results);
        }

    } catch (error) {
        console.error("❌ Error scraping MotoGP data:", error);
    } finally {
        await browser.close();
        console.log("🚪 Closed browser.");
    }

    return results;
}

// 🔹 Function to Save Data to Supabase
async function saveToSupabase(race_id, championship_id, results) {
    console.log("📡 Sending data to Supabase...");

    const { data, error } = await db
        .from('motogp_results')
        .upsert(results.map(r => ({
            championship_id: championship_id,
            race_id: race_id,
            position: r.position,
            rider_number: r.rider_number,
            rider_name: r.rider_name,
            team: r.team,
            points: r.points
        })), { onConflict: 'championship_id, user_id, calendar_id, rider_id' })
        .select();

    if (error) {
        console.error("❌ Error saving data to Supabase:", error);
    } else {
        console.log("✅ Data saved successfully in Supabase:", data);
    }
}

module.exports = router;
