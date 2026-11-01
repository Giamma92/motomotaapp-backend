const db = require('../models/db');

let cache = null;
let lastFetch = 0;
const CACHE_TTL = 30000; // 30s in-memory cache

async function getMetadataMap() {
  const now = Date.now();
  if (cache && (now - lastFetch) < CACHE_TTL) {
    return cache;
  }
  try {
    const { data, error } = await db.storage.from('avatars').download('user_metadata.json');
    if (error || !data) {
      cache = {};
    } else {
      const text = await data.text();
      cache = JSON.parse(text || '{}');
    }
  } catch (err) {
    console.warn('Could not read user_metadata.json from storage:', err.message);
    cache = cache || {};
  }
  lastFetch = now;
  return cache;
}

async function saveMetadataMap(map) {
  cache = map;
  lastFetch = Date.now();
  try {
    const buf = Buffer.from(JSON.stringify(map, null, 2));
    await db.storage.from('avatars').upload('user_metadata.json', buf, {
      contentType: 'application/json',
      upsert: true
    });
  } catch (err) {
    console.error('Failed to persist user_metadata.json:', err);
  }
}

async function setAlias(userId, alias) {
  const map = await getMetadataMap();
  if (!map[userId]) map[userId] = {};
  map[userId].alias = alias ? alias.trim() : null;
  await saveMetadataMap(map);
}

async function getAlias(userId) {
  const map = await getMetadataMap();
  return map[userId]?.alias || null;
}

async function setResetRequested(userId, requested = true) {
  const map = await getMetadataMap();
  if (!map[userId]) map[userId] = {};
  map[userId].pwd_reset_requested = !!requested;
  map[userId].pwd_reset_requested_at = requested ? new Date().toISOString() : null;
  await saveMetadataMap(map);
}

async function attachAliases(usersArray, getUserIdFn = u => u?.id) {
  if (!Array.isArray(usersArray) || !usersArray.length) return usersArray;
  const map = await getMetadataMap();
  for (const item of usersArray) {
    const uid = getUserIdFn(item);
    if (uid && map[uid]?.alias) {
      if (typeof item === 'object' && item !== null) {
        item.alias = map[uid].alias;
        if (item.user_id && typeof item.user_id === 'object') {
          item.user_id.alias = map[uid].alias;
        }
      }
    }
  }
  return usersArray;
}

async function attachUserMeta(usersArray) {
  if (!Array.isArray(usersArray) || !usersArray.length) return usersArray;
  const map = await getMetadataMap();
  for (const item of usersArray) {
    const uid = item?.id;
    if (uid && map[uid]) {
      item.alias = map[uid].alias || null;
      item.pwd_reset_requested = !!map[uid].pwd_reset_requested;
      item.pwd_reset_requested_at = map[uid].pwd_reset_requested_at || null;
    } else {
      item.pwd_reset_requested = false;
      item.pwd_reset_requested_at = null;
    }
  }
  return usersArray;
}

module.exports = {
  getMetadataMap,
  setAlias,
  getAlias,
  setResetRequested,
  attachAliases,
  attachUserMeta
};
