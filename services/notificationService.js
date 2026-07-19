const db = require('../models/db');
const { sendPushToMultipleUsers } = require('./pushNotificationService');

async function createNotification({ userId, championshipId, category, title, body, type = 'info', link = null }) {
  const { data, error } = await db
    .from('notifications')
    .insert({ user_id: userId, championship_id: championshipId, category, title, body, type, link })
    .select('id')
    .single();

  if (error) {
    console.error('Failed to create notification:', error);
    return null;
  }
  return data;
}

async function getNotifications(userId, { unreadOnly = false, limit = 50, offset = 0 } = {}) {
  let query = db
    .from('notifications')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (unreadOnly) {
    query = query.eq('is_read', false);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

async function getUnreadCount(userId) {
  const { count, error } = await db
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('is_read', false);

  if (error) throw error;
  return count || 0;
}

async function markAsRead(userId, notificationId) {
  const { data, error } = await db
    .from('notifications')
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq('id', notificationId)
    .eq('user_id', userId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function markAllAsRead(userId) {
  const { error } = await db
    .from('notifications')
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('is_read', false);

  if (error) throw error;
  return true;
}

async function notifyChampionshipUsers({ championshipId, excludeUserId, category, title, body, type = 'info', link = null }) {
  const { data: participants, error: participantsError } = await db
    .from('fantasy_teams')
    .select('user_id')
    .eq('championship_id', championshipId);

  if (participantsError) {
    console.error('Failed to fetch championship participants:', participantsError);
    return false;
  }

  const userIds = (participants || [])
    .map(p => p.user_id?.id || p.user_id)
    .filter(id => id && id !== excludeUserId);

  if (userIds.length === 0) return false;

  const { data: allSettings, error: settingsError } = await db
    .from('user_notification_settings')
    .select(`user_id, ${category}`)
    .eq('championship_id', championshipId)
    .in('user_id', userIds);

  if (settingsError) {
    console.error('Failed to fetch notification settings:', settingsError);
    return false;
  }

  const settingsMap = new Map((allSettings || []).map(s => [s.user_id, s[category]]));

  const notifications = userIds
    .filter(id => settingsMap.get(id) !== false)
    .map(userId => ({
      user_id: userId,
      championship_id: championshipId,
      category,
      title,
      body,
      type,
      link
    }));

  if (notifications.length === 0) return false;

  const { error: insertError } = await db
    .from('notifications')
    .insert(notifications);

  if (insertError) {
    console.error('Failed to bulk insert notifications:', insertError);
    return false;
  }

  sendPushToMultipleUsers(notifications.map(n => n.user_id), {
    notification: {
      title,
      body: body || title,
      data: { link, category, championshipId },
      icon: '/favicon.ico',
      badge: '/favicon.ico',
      vibrate: [200, 100, 200]
    }
  }).catch(err => console.error('Failed to send push notifications:', err));

  return true;
}

async function deleteReadNotifications(userId) {
  const { error } = await db
    .from('notifications')
    .delete()
    .eq('user_id', userId)
    .eq('is_read', true);

  if (error) throw error;
  return true;
}

async function getNotificationSettings(userId, championshipId) {
  const { data, error } = await db
    .from('user_notification_settings')
    .select('*')
    .eq('user_id', userId)
    .eq('championship_id', championshipId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function upsertNotificationSettings(userId, championshipId, settings) {
  const payload = {
    user_id: userId,
    championship_id: championshipId,
    lineup: settings.lineup ?? true,
    race_bet: settings.race_bet ?? true,
    sprint_bet: settings.sprint_bet ?? true,
    score_update: settings.score_update ?? true,
    standing_change: settings.standing_change ?? true,
    race_cancelled: settings.race_cancelled ?? true,
    general: settings.general ?? true
  };

  const { data, error } = await db
    .from('user_notification_settings')
    .upsert(payload, { onConflict: 'user_id, championship_id' })
    .select()
    .single();

  if (error) throw error;
  return data;
}

module.exports = {
  createNotification,
  getNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  notifyChampionshipUsers,
  getNotificationSettings,
  upsertNotificationSettings,
  deleteReadNotifications
};
