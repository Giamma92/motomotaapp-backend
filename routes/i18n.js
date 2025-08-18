const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
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

/**
 * PUT /api/i18n/:code/:namespace/:key/:value
 * Upserts a new i18n translation.
 * Expected body: { value }
 */
router.put('/i18n/new', authMiddleware, async (req, res) => {
  const { code, namespace, key, value, description } = req.body;

  try {

    let { data: keyData, error: keyError } = await db
      .from('i18n_keys')
      .upsert({
          namespace: namespace,
          key: key,
          description: description
      }, { onConflict: 'key' })
      .select();

    if (keyError || keyData.length === 0) {
      console.error("Error upserting i18n key:", keyError);
      return res.status(500).json({ error: keyError.message });
    }

    const { data, error } = await db
      .from('i18n_translations')
      .upsert({
          language_id: code == 'en' ? 1 : 2,
          key_id: keyData[0].id,
          value: value,
          updated_at: new Date().toISOString()
      })
      .select();

    if (error) {
      console.error("Error upserting i18n translation:", error);
      return res.status(500).json({ error: error.message });
    }
    
    res.status(201).json(data[0]);
  } catch (err) {
    console.error("Unexpected error in i18n translation endpoint:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;


