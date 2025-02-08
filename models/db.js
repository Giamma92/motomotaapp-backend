const { createClient } = require('@supabase/supabase-js');

// Supabase setup
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);
//console.log('Supabase Instance: ', supabase)

module.exports = supabase;