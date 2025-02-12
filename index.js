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
const betsRoutes = require('./routes/bets');
const userRoutes = require('./routes/user'); 
const standingsRoutes = require('./routes/standings'); 
const calendarRoutes = require('./routes/calendar'); 
const fantasyTeamRoutes = require('./routes/fantasyTeam');
const championshipRoutes = require('./routes/championship');


// Define routes

// Public endpoint for authentication
app.use('/api', authRoutes);
// Protected endpoints
app.use('/api', userRoutes);
app.use('/api/riders', ridersRoutes);
app.use('/api/bets', betsRoutes);
app.use('/api', standingsRoutes);
app.use('/api', calendarRoutes);
app.use('/api', fantasyTeamRoutes);
app.use('/api', championshipRoutes);


// Health-check route
app.get('/', (req, res) => {
  res.send('MotoMota backend is running!');
});

// Add more endpoints (teams, races, leaderboard) here...

// Start server
app.listen(port, () => {
  console.log(`Backend running on http://localhost:${port}`);
});