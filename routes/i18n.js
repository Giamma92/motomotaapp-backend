const express = require('express');
const router = express.Router();
const db = require('../models/db');

// Public endpoint to fetch translations for a language code
// GET /api/i18n/:code  e.g., /api/i18n/en
router.get('/i18n/:code', async (req, res) => {
  try {
    const code = String(req.params.code || '').trim();

    if (!code) {
      return res.status(400).json({ error: 'Language code is required' });
    }

    // Find language by code and ensure it is active
    const { data: language, error: langError } = await db
      .from('languages')
      .select('id, code')
      .eq('code', code)
      .eq('is_active', true)
      .maybeSingle();

    if (langError) {
      return res.status(500).json({ error: langError.message });
    }
    if (!language) {
      return res.status(404).json({ error: 'Language not found or inactive' });
    }

    // Fetch translations joined with keys for this language
    const { data: translations, error: trError } = await db
      .from('i18n_translations')
      .select('value, i18n_keys ( key, namespace )')
      .eq('language_id', language.id);

    if (trError) {
      return res.status(500).json({ error: trError.message });
    }

    // Build a flat dictionary: key -> value
    const dictionary = {};
    for (const row of translations || []) {
      const k = row?.i18n_keys?.key;
      const v = row?.value;
      if (typeof k === 'string' && typeof v === 'string') {
        dictionary[k] = v;
      }
    }

    return res.json(dictionary);
  } catch (err) {
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;


