const DEFAULT_CHAMPIONSHIP_TIMEZONE = 'Europe/Rome';
const DEFAULT_TIME = '00:00:00';

function normalizeTimeZone(timeZone) {
  if (!timeZone || typeof timeZone !== 'string') {
    return DEFAULT_CHAMPIONSHIP_TIMEZONE;
  }

  try {
    Intl.DateTimeFormat(undefined, { timeZone }).format(new Date());
    return timeZone;
  } catch (_) {
    return DEFAULT_CHAMPIONSHIP_TIMEZONE;
  }
}

function parseYyyyMmDd(ymd) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!match) return null;

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3])
  };
}

function parseHms(hms) {
  const [hh = '00', mm = '00', ss = '00'] = String(hms || DEFAULT_TIME).split(':');
  return {
    hour: Number(hh) || 0,
    minute: Number(mm) || 0,
    second: Number(ss) || 0
  };
}

function getTimeZoneParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: normalizeTimeZone(timeZone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });

  const parts = formatter.formatToParts(date);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value || 0);

  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second')
  };
}

function getTimeZoneOffsetMs(date, timeZone) {
  const parts = getTimeZoneParts(date, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    0
  );

  return asUtc - date.getTime();
}

function buildZonedDateTime(ymd, hms = DEFAULT_TIME, timeZone = DEFAULT_CHAMPIONSHIP_TIMEZONE) {
  const dateParts = parseYyyyMmDd(ymd);
  if (!dateParts) return null;

  const timeParts = parseHms(hms);
  const tz = normalizeTimeZone(timeZone);
  const guessUtc = new Date(Date.UTC(
    dateParts.year,
    dateParts.month - 1,
    dateParts.day,
    timeParts.hour,
    timeParts.minute,
    timeParts.second,
    0
  ));

  const initialOffset = getTimeZoneOffsetMs(guessUtc, tz);
  let result = new Date(guessUtc.getTime() - initialOffset);
  const correctedOffset = getTimeZoneOffsetMs(result, tz);

  if (correctedOffset !== initialOffset) {
    result = new Date(guessUtc.getTime() - correctedOffset);
  }

  return result;
}

function formatYyyyMmDd(date, timeZone = DEFAULT_CHAMPIONSHIP_TIMEZONE) {
  const parts = getTimeZoneParts(date, timeZone);
  const month = String(parts.month).padStart(2, '0');
  const day = String(parts.day).padStart(2, '0');
  return `${parts.year}-${month}-${day}`;
}

function formatSqlTimestamp(date = new Date(), timeZone = DEFAULT_CHAMPIONSHIP_TIMEZONE) {
  const tz = normalizeTimeZone(timeZone);
  const parts = getTimeZoneParts(date, tz);
  const year = String(parts.year).padStart(4, '0');
  const month = String(parts.month).padStart(2, '0');
  const day = String(parts.day).padStart(2, '0');
  const hour = String(parts.hour).padStart(2, '0');
  const minute = String(parts.minute).padStart(2, '0');
  const second = String(parts.second).padStart(2, '0');
  const millisecond = String(date.getMilliseconds()).padStart(3, '0');

  return `${year}-${month}-${day} ${hour}:${minute}:${second}.${millisecond}`;
}

function isSameYyyyMmDd(date, ymd, timeZone = DEFAULT_CHAMPIONSHIP_TIMEZONE) {
  return formatYyyyMmDd(date, timeZone) === ymd;
}

function addDaysToYyyyMmDd(ymd, days) {
  const parts = parseYyyyMmDd(ymd);
  if (!parts) return null;

  const date = new Date(parts.year, parts.month - 1, parts.day);
  date.setDate(date.getDate() + days);

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getChampionshipWindow(calendarRow, timeZone = DEFAULT_CHAMPIONSHIP_TIMEZONE) {
  if (!calendarRow?.event_date) {
    return null;
  }

  const tz = normalizeTimeZone(timeZone);
  const raceDate = calendarRow.event_date;
  const dayBeforeRace = addDaysToYyyyMmDd(raceDate, -1);
  const threeDaysBeforeRace = addDaysToYyyyMmDd(raceDate, -3);

  if (!dayBeforeRace || !threeDaysBeforeRace) {
    return null;
  }

  const lineupsStart = buildZonedDateTime(threeDaysBeforeRace, DEFAULT_TIME, tz);
  const lineupsEnd = buildZonedDateTime(dayBeforeRace, calendarRow.qualifications_time || DEFAULT_TIME, tz);
  const sprintBetStart = buildZonedDateTime(dayBeforeRace, DEFAULT_TIME, tz);
  const sprintBetEndBase = buildZonedDateTime(dayBeforeRace, calendarRow.sprint_time || DEFAULT_TIME, tz);
  const raceBetStart = sprintBetEndBase ? new Date(sprintBetEndBase.getTime() + 30 * 60 * 1000) : null;
  const eventTime = buildZonedDateTime(raceDate, calendarRow.event_time || DEFAULT_TIME, tz);

  let raceBetEnd = null;
  const eventHour = parseHms(calendarRow.event_time || DEFAULT_TIME).hour;
  if (eventHour <= 14) {
    raceBetEnd = buildZonedDateTime(raceDate, DEFAULT_TIME, tz);
  } else {
    raceBetEnd = buildZonedDateTime(raceDate, '13:59:59', tz);
  }

  const sprintBetEnd = sprintBetEndBase ? new Date(sprintBetEndBase.getTime() - 30 * 60 * 1000) : null;

  return {
    timeZone: tz,
    raceDate,
    lineupsStart,
    lineupsEnd,
    sprintBetStart,
    sprintBetEnd,
    raceBetStart,
    raceBetEnd,
    eventTime
  };
}

function canSubmitLineup(calendarRow, timeZone, now = new Date()) {
  const window = getChampionshipWindow(calendarRow, timeZone);
  if (!window?.lineupsStart || !window?.lineupsEnd) return false;
  return now >= window.lineupsStart && now <= window.lineupsEnd;
}

function canSubmitSprintBet(calendarRow, timeZone, now = new Date()) {
  const window = getChampionshipWindow(calendarRow, timeZone);
  if (!window?.sprintBetStart || !window?.sprintBetEnd) return false;
  if (isSameYyyyMmDd(now, window.raceDate, window.timeZone)) return false;
  return now >= window.sprintBetStart && now < window.sprintBetEnd;
}

function canSubmitRaceBet(calendarRow, timeZone, now = new Date()) {
  const window = getChampionshipWindow(calendarRow, timeZone);
  if (!window?.raceBetStart || !window?.raceBetEnd) return false;
  return now >= window.raceBetStart && now <= window.raceBetEnd;
}

module.exports = {
  DEFAULT_CHAMPIONSHIP_TIMEZONE,
  normalizeTimeZone,
  formatYyyyMmDd,
  formatSqlTimestamp,
  buildZonedDateTime,
  getChampionshipWindow,
  canSubmitLineup,
  canSubmitSprintBet,
  canSubmitRaceBet
};
