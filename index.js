const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// route import (you can structure routes into separate files)
const authRoutes = require('./routes/auth');
const ridersRoutes = require('./routes/riders');
const betsRoutes = require('./routes/raceBets');
const userRoutes = require('./routes/user'); 
const userSettingsRoute = require('./routes/userSettings');
const standingsRoutes = require('./routes/standings'); 
const calendarRoutes = require('./routes/calendar'); 
const fantasyTeamRoutes = require('./routes/fantasyTeam');
const championshipRoutes = require('./routes/championship');
const lineupsRoutes = require('./routes/lineups');
const sprintBetRoutes = require('./routes/sprintBet');
const raceDetails = require('./routes/raceDetails');
const config = require('./routes/config');
const scrapeMotoGp = require('./routes/scrapeMotoGP');
const calcScores = require('./routes/calcScores');
const i18nRoutes = require('./routes/i18n');


// Define routes

// Public endpoint for authentication
app.use('/api', authRoutes);
// Protected endpoints
app.use('/api', userRoutes);
app.use('/api', ridersRoutes);
app.use('/api', standingsRoutes);
app.use('/api', calendarRoutes);
app.use('/api', fantasyTeamRoutes);
app.use('/api', championshipRoutes);
app.use('/api', lineupsRoutes);
app.use('/api', sprintBetRoutes);
app.use('/api', betsRoutes);
app.use('/api', raceDetails);
app.use('/api',userSettingsRoute);
app.use('/api', config); 
app.use('/api', scrapeMotoGp);
app.use('/api', calcScores);
app.use('/api', i18nRoutes);

// Health-check route
app.get('/', (req, res) => {
  res.send('MotoMota backend is running!');
});

// Add more endpoints (teams, races, leaderboard) here...

// Start server
app.listen(port, () => {
  console.log(`Backend running on http://localhost:${port}`);
});