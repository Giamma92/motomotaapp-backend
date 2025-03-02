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
    const calendarRace = await loadCalendarRace(calendarId);
    const calendarCountry = calendarRace?.race_id?.country ?? 'unknown';
    if (calendarCountry == 'unknown') 
        return res.status(500).json({ error: 'No calendar race found with provided id' });

    const riders = await loadChampionshipRiders(championshipId);

    let results = [];
    let url = '';

    url = `${baseUrl}/${year}/${calendarCountry}/motogp/q1/classification`;
    const q1Data = await scrapeMotoGPResults(url);

    url = `${baseUrl}/${year}/${calendarCountry}/motogp/q2/classification`;
    const q2Data = await scrapeMotoGPResults(url);

    if(!!q1Data && q1Data.length != 0 && !!q2Data && q2Data.length != 0) {
        
        q1DataSlice = q1Data.slice(2);
        q1DataFixed = q1DataSlice.map(q => { return {
            position: q.position + 10,
            points: q.points,
            rider_number: q.rider_number,
            rider_name: q.rider_name,
            team: q.team
        }});
        qualifyingData = [...q2Data, ...q1DataFixed];
        //console.log("Qualifying data fixed", qualifyingData);
        console.log(`⌛ Processing qualifying data: ${qualifyingData.length} rows...`);
        for(let i=0; i<qualifyingData.length; i++) {
            let row = qualifyingData[i];
            let champRider = riders?.find(r => r.rider_id.number == +row.rider_number);
            
            if(!champRider?.rider_id?.id)
                continue;
            
            results.push({
                rider_id: champRider.rider_id.id,
                championship_id: +championshipId,
                calendar_id: +calendarId,
                qualifying_position: row.position,
                qualifying_points: getMotoGPPoints(row.position),
            });
        }
        console.log(`✅ Processed qualifying data completed!`);
    }

    url = `${baseUrl}/${year}/${calendarCountry}/motogp/spr/classification`;
    const sprData = await scrapeMotoGPResults(url);

    if(!!sprData && sprData.length != 0) {
        console.log(`⌛ Processing sprint data: ${sprData.length} rows...`);
        for(let i=0; i<sprData.length; i++) {
            let row = sprData[i];
            let champRider = riders?.find(r => r.rider_id.number == +row.rider_number);
            
            if(!champRider?.rider_id?.id)
                continue;
            
            results.push({
                rider_id: champRider.rider_id.id,
                championship_id: +championshipId,
                calendar_id: +calendarId,
                sprint_position: row.position,
                sprint_points: row.points,
            });
        }
        console.log(`✅ Processed sprint data completed!`);
    }

    url = `${baseUrl}/${year}/${calendarCountry}/motogp/rac/classification`;
    const racData = await scrapeMotoGPResults(url);

    if(!!racData && racData.length != 0) {
        console.log(`⌛ Processing race data: ${sprData.length} rows...`);
        for(let i=0; i<racData.length; i++) {
            let row = racData[i];
            const champRider = riders?.find(r => r.rider_id.number == +row.rider_number);
            
            if(!champRider?.rider_id?.id)
                continue;
            
            results.push({
                championship_id: +championshipId,
                calendar_id: +calendarId,
                rider_id: champRider.rider_id.id,
                race_position: row.position,
                race_points: row.points,
            });
        }
        console.log(`✅ Processed race data completed!`);
    }

    const mergedResults = mergeResults(results);

    console.log("Merged values: ", mergedResults);
    
    await saveToSupabase(mergedResults);

    res.json(mergedResults);
});

async function loadChampionshipRiders(championshipId) {
    try {
        console.log(`⌛ Waiting for load riders of championship (id: ${championshipId})...`);
        const { data, error } = await db
            .from('championship_riders')
            .select(`
            id,
            rider_id(
                id,
                first_name,
                last_name,
                number
            )
            `)
            .eq('championship_id', championshipId);
        if (error) {
            console.error('Error fetching championship riders:', error);
            return {};
        }
        console.log("✅ Championship riders found!", data);
        return data;
    } catch (err) {
        console.error('Unexpected error fetching riders:', err);
        return {};
    }
}

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

async function loadCalendarRace(calendarId) {
    try {
        console.log(`⌛ Waiting for load calendar race (id: ${calendarId})...`);
        const { data, error } = await db
            .from('calendar')
            .select(`
                id,
                race_id(name,location,country)
                `)
            .eq('id', calendarId)
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
        let tableExists = await page.$('.results-table__table');
        if (!tableExists) {
            console.log("❌ Table not found.");
            console.log("⌛ Waiting for the table to appear...");
            try {
                tableExists = await page.waitForSelector('.results-table__table', { timeout: 15000 }); // Wait longer if needed
            } catch(error){
                console.log("❌ Table still not found. Trying alternative methods...");
                return;
            }
            // Screenshot to debug
            //await page.screenshot({ path: 'debug_screenshot.png', fullPage: true });
            //console.log("📸 Screenshot saved as 'debug_screenshot.png' to check what is loaded.");
            
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
        }

    } catch (error) {
        console.error("❌ Error scraping MotoGP data:", error);
    } finally {
        await browser.close();
        console.log("🚪 Closed browser.");
    }

    return results;
}

function getMotoGPPoints(position) {
    const pointsTable = {
        1: 25,  2: 20,  3: 16,  4: 13,  5: 11,
        6: 10,  7: 9,   8: 8,   9: 7,  10: 6,
        11: 5,  12: 4,  13: 3,  14: 2,  15: 1
    };

    return pointsTable[position] || 0;
}

function mergeResults(data) {
    const merged = {};

    data.forEach(item => {
        const key = `${item.championship_id}-${item.rider_id}-${item.calendar_id}`;

        if (!merged[key]) {
            merged[key] = { ...item };
        } else {
            // Merge properties
            Object.keys(item).forEach(prop => {
                if (prop !== 'id' && typeof item[prop] === 'number') {
                    if (!merged[key][prop]) {
                        merged[key][prop] = item[prop];
                    }
                    //merged[key][prop] = (merged[key][prop] || 0) + item[prop];
                }
            });
        }
    });

    return Object.values(merged);
}

// 🔹 Function to Save Data to Supabase
async function saveToSupabase(results) {
    console.log("📡 Sending data to Supabase...");
    try {
        const { data, error } = await db
            .from('motogp_results')
            .upsert(results, { onConflict: 'championship_id, calendar_id, rider_id' })
            .select();

            if (error) {
                console.error('❌ Error saving data to Supabase:', error);
                return {};
            }
            if(data?.length)
                console.log("✅ Results saved successfully!", data);
            else
                console.log("❌ No data saved!", data);
            return data;

    } catch (error) {
        console.error("❌ Error saving data to Supabase:", error);
        return {};
    }
}

module.exports = router;
