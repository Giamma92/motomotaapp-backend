const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

// Supabase setup
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
  {
    auth: { persistSession: false },
    realtime: { transport: ws }
  }
);

module.exports = supabase;