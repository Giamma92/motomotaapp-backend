const express = require('express');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Supabase setup
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

app.use(express.json());
app.use(cors());

// Example: Get all pilots
app.get('/pilots', async (req, res) => {
  const { data, error } = await supabase.from('pilots').select('*');
  if (error) return res.status(500).json({ error });
  res.json(data);
});

// Example: Submit a bet
app.post('/bets', async (req, res) => {
  const { user_id, race_id, predicted_podium } = req.body;
  const { data, error } = await supabase
    .from('bets')
    .insert([{ user_id, race_id, predicted_podium }]);

  if (error) return res.status(500).json({ error });
  res.json(data);
});

// Add more endpoints (teams, races, leaderboard) here...

app.listen(port, () => {
  console.log(`Backend running on http://localhost:${port}`);
});