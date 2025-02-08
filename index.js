const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// route import (you can structure routes into separate files)
const ridersRoutes = require('./routes/riders');
const betsRoutes = require('./routes/bets');

// Define routes
app.use('/api/riders', ridersRoutes);
app.use('/api/bets', betsRoutes);

// Health-check route
app.get('/', (req, res) => {
  res.send('FantaGP backend is running!');
});

// Add more endpoints (teams, races, leaderboard) here...

// Start server
app.listen(port, () => {
  console.log(`Backend running on http://localhost:${port}`);
});