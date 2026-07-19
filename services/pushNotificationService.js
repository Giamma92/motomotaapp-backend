const webpush = require('web-push');
const db = require('../models/db');

function getVapidConfig() {
  return {
    publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY,
    subject: process.env.VAPID_SUBJECT || 'mailto:admin@motomota.app'
  };
}

function isPushEnabled() {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

function initWebPush() {
  if (!isPushEnabled()) return false;

  const config = getVapidConfig();
  webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  return true;
}

initWebPush();

async function saveSubscription(userId, subscription) {
  const { data: existing, error: existingError } = await db
    .from('user_push_subscriptions')
    .select('id')
    .eq('user_id', userId)
    .eq('endpoint', subscription.endpoint)
    .maybeSingle();

  if (existingError) {
    console.error('Error checking existing push subscription:', existingError);
    return null;
  }

  if (existing) return existing;

  const { data, error } = await db
    .from('user_push_subscriptions')
    .insert({
      user_id: userId,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys?.p256dh || '',
      auth: subscription.keys?.auth || ''
    })
    .select('id')
    .single();

  if (error) {
    console.error('Error saving push subscription:', error);
    return null;
  }

  return data;
}

async function deleteSubscription(userId, endpoint) {
  const { error } = await db
    .from('user_push_subscriptions')
    .delete()
    .eq('user_id', userId)
    .eq('endpoint', endpoint);

  if (error) {
    console.error('Error deleting push subscription:', error);
    return false;
  }

  return true;
}

async function getSubscriptions(userId) {
  const { data, error } = await db
    .from('user_push_subscriptions')
    .select('endpoint, p256dh, auth')
    .eq('user_id', userId);

  if (error) {
    console.error('Error fetching push subscriptions:', error);
    return [];
  }

  return (data || []).map(sub => ({
    endpoint: sub.endpoint,
    keys: { p256dh: sub.p256dh, auth: sub.auth }
  }));
}

async function sendPushToUser(userId, payload) {
  if (!isPushEnabled()) return false;

  const subscriptions = await getSubscriptions(userId);
  if (subscriptions.length === 0) return false;

  const results = await Promise.allSettled(
    subscriptions.map(sub =>
      webpush.sendNotification(sub, JSON.stringify(payload)).catch(err => {
        if (err.statusCode === 410 || err.statusCode === 404) {
          return { expired: true, endpoint: sub.endpoint };
        }
        console.error('Push send error:', err.message);
        return null;
      })
    )
  );

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value?.expired) {
      await deleteSubscription(userId, result.value.endpoint);
    }
  }

  return true;
}

async function sendPushToMultipleUsers(userIds, payload) {
  if (!isPushEnabled() || userIds.length === 0) return false;

  const results = await Promise.allSettled(
    userIds.map(userId => sendPushToUser(userId, payload))
  );

  return true;
}

module.exports = {
  saveSubscription,
  deleteSubscription,
  sendPushToUser,
  sendPushToMultipleUsers,
  getVapidPublicKey: () => getVapidConfig().publicKey
};
