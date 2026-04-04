const https = require('https');
const db = require('../models/db');

const TELEGRAM_API_HOST = 'api.telegram.org';

function isTelegramNotificationEnabled() {
  return process.env.TELEGRAM_NOTIFICATIONS_ENABLED === 'true';
}

function getTelegramConfig() {
  return {
    enabled: isTelegramNotificationEnabled(),
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID
  };
}

function escapeTelegramHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatUserName(user) {
  if (!user) return 'Utente sconosciuto';

  const fullName = `${user.first_name || ''} ${user.last_name || ''}`.trim();
  return fullName || user.id || 'Utente sconosciuto';
}

function formatRiderName(rider) {
  if (!rider) return 'Pilota sconosciuto';

  const fullName = `${rider.first_name || ''} ${rider.last_name || ''}`.trim();
  if (fullName && rider.number) {
    return `${fullName} (#${rider.number})`;
  }

  return fullName || `Pilota ${rider.id ?? ''}`.trim();
}

function formatRaceName(calendarRow) {
  const raceName = calendarRow?.race_id?.name;
  const raceLocation = calendarRow?.race_id?.location;

  if (raceName && raceLocation) {
    return `${raceName} (${raceLocation})`;
  }

  return raceName || raceLocation || `Gara ${calendarRow?.id ?? ''}`.trim();
}

async function loadBetNotificationContext({ userId, riderId, championshipId, calendarId }) {
  const [{ data: user, error: userError }, { data: rider, error: riderError }, { data: calendarRow, error: calendarError }] = await Promise.all([
    db.from('users').select('id, first_name, last_name').eq('id', userId).maybeSingle(),
    db.from('riders').select('id, first_name, last_name, number').eq('id', riderId).maybeSingle(),
    db
      .from('calendar')
      .select('id, event_date, race_id(name, location)')
      .eq('championship_id', championshipId)
      .eq('id', calendarId)
      .maybeSingle()
  ]);

  if (userError) throw userError;
  if (riderError) throw riderError;
  if (calendarError) throw calendarError;

  return {
    userName: formatUserName(user),
    riderName: formatRiderName(rider),
    raceName: formatRaceName(calendarRow),
    eventDate: calendarRow?.event_date || null
  };
}

async function loadLineupNotificationContext({
  userId,
  championshipId,
  calendarId,
  qualifyingRiderId,
  raceRiderId
}) {
  const [
    { data: user, error: userError },
    { data: qualifyingRider, error: qualifyingRiderError },
    { data: raceRider, error: raceRiderError },
    { data: calendarRow, error: calendarError }
  ] = await Promise.all([
    db.from('users').select('id, first_name, last_name').eq('id', userId).maybeSingle(),
    db.from('riders').select('id, first_name, last_name, number').eq('id', qualifyingRiderId).maybeSingle(),
    db.from('riders').select('id, first_name, last_name, number').eq('id', raceRiderId).maybeSingle(),
    db
      .from('calendar')
      .select('id, event_date, race_id(name, location)')
      .eq('championship_id', championshipId)
      .eq('id', calendarId)
      .maybeSingle()
  ]);

  if (userError) throw userError;
  if (qualifyingRiderError) throw qualifyingRiderError;
  if (raceRiderError) throw raceRiderError;
  if (calendarError) throw calendarError;

  return {
    userName: formatUserName(user),
    qualifyingRiderName: formatRiderName(qualifyingRider),
    raceRiderName: formatRiderName(raceRider),
    raceName: formatRaceName(calendarRow),
    eventDate: calendarRow?.event_date || null
  };
}

function buildBetTelegramMessage({ betType, context, bet }) {
  const typeLabel = betType === 'sprint' ? 'Sprint bet' : 'Race bet';
  const lines = [
    `<b>Nuova scommessa salvata</b>`,
    `<b>Tipo:</b> ${escapeTelegramHtml(typeLabel)}`,
    `<b>Utente:</b> ${escapeTelegramHtml(context.userName)}`,
    `<b>Gara:</b> ${escapeTelegramHtml(context.raceName)}`,
    `<b>Pilota:</b> ${escapeTelegramHtml(context.riderName)}`,
    `<b>Posizione:</b> ${escapeTelegramHtml(bet.position)}`,
    `<b>Punti:</b> ${escapeTelegramHtml(bet.points)}`
  ];

  if (context.eventDate) {
    lines.splice(4, 0, `<b>Data evento:</b> ${escapeTelegramHtml(context.eventDate)}`);
  }

  return lines.join('\n');
}

function buildLineupTelegramMessage({ context }) {
  const lines = [
    `<b>Nuovo schieramento salvato</b>`,
    `<b>Utente:</b> ${escapeTelegramHtml(context.userName)}`,
    `<b>Gara:</b> ${escapeTelegramHtml(context.raceName)}`
  ];

  if (context.eventDate) {
    lines.push(`<b>Data evento:</b> ${escapeTelegramHtml(context.eventDate)}`);
  }

  lines.push(`<b>Pilota qualifica:</b> ${escapeTelegramHtml(context.qualifyingRiderName)}`);
  lines.push(`<b>Pilota gara:</b> ${escapeTelegramHtml(context.raceRiderName)}`);

  return lines.join('\n');
}

function sendTelegramMessage(text) {
  const { enabled, botToken, chatId } = getTelegramConfig();
  if (!enabled) return Promise.resolve(false);

  if (!botToken || !chatId) {
    console.warn('Telegram notifications enabled but TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing.');
    return Promise.resolve(false);
  }

  const payload = JSON.stringify({
    chat_id: chatId,
    text,
    parse_mode: 'HTML'
  });

  const options = {
    hostname: TELEGRAM_API_HOST,
    path: `/bot${botToken}/sendMessage`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    },
    timeout: 5000
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let responseBody = '';

      res.on('data', chunk => {
        responseBody += chunk;
      });

      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(true);
          return;
        }

        reject(new Error(`Telegram API error (${res.statusCode}): ${responseBody}`));
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error('Telegram API timeout'));
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function notifyBetPlaced({ betType, championshipId, userId, riderId, calendarId, position, points }) {
  const { enabled } = getTelegramConfig();
  if (!enabled) return false;

  const context = await loadBetNotificationContext({
    userId,
    riderId,
    championshipId,
    calendarId
  });

  const message = buildBetTelegramMessage({
    betType,
    context,
    bet: { position, points }
  });

  await sendTelegramMessage(message);
  return true;
}

async function notifyLineupPlaced({
  championshipId,
  userId,
  calendarId,
  qualifyingRiderId,
  raceRiderId
}) {
  const { enabled } = getTelegramConfig();
  if (!enabled) return false;

  const context = await loadLineupNotificationContext({
    userId,
    championshipId,
    calendarId,
    qualifyingRiderId,
    raceRiderId
  });

  const message = buildLineupTelegramMessage({ context });
  await sendTelegramMessage(message);
  return true;
}

module.exports = {
  notifyBetPlaced,
  notifyLineupPlaced
};
