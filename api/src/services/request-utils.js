export function boundedIntegerParam(value, { defaultValue, min = 1, max } = {}) {
  if (value === undefined || value === null || value === '') return defaultValue;
  let parsed;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) return defaultValue;
    parsed = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) return defaultValue;
    parsed = Number.parseInt(trimmed, 10);
  } else {
    return defaultValue;
  }
  const lowerBounded = Math.max(parsed, min);
  return max !== undefined ? Math.min(lowerBounded, max) : lowerBounded;
}

export function isInvalidIntegerParam(value, { min } = {}) {
  if (value === undefined || value === null || value === '') return false;
  let parsed;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) return true;
    parsed = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) return true;
    parsed = Number.parseInt(trimmed, 10);
  } else {
    return true;
  }
  if (min !== undefined && parsed < min) return true;
  return false;
}

export function stringParam(value, defaultValue) {
  if (value === undefined || value === null) return defaultValue;
  return typeof value === 'string' ? value : defaultValue;
}

export function trimmedStringParam(value, defaultValue) {
  const str = stringParam(value, defaultValue);
  if (str === undefined || str === null) return defaultValue;
  const trimmed = str.trim();
  return trimmed || defaultValue;
}

export function isInvalidStringParam(value) {
  return value !== undefined && value !== null && value !== '' && typeof value !== 'string';
}

export function requestBodyObject(req) {
  const body = req?.body;
  return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
}

const ISO_TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:[Zz]|([+-])(\d{2}):?(\d{2}))?)?$/;

function isValidCalendarDate(year, month, day) {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return (
    date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
  );
}

export function isValidIsoTimestamp(value) {
  if (typeof value !== 'string') return false;
  const match = value.match(ISO_TIMESTAMP_RE);
  if (!match) return false;

  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw, offsetSign, offsetHourRaw, offsetMinuteRaw] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  if (month < 1 || month > 12 || !isValidCalendarDate(year, month, day)) return false;

  if (hourRaw === undefined) return true;
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = secondRaw === undefined ? 0 : Number(secondRaw);
  if (hour > 23 || minute > 59 || second > 59) return false;

  if (offsetSign) {
    const offsetHour = Number(offsetHourRaw);
    const offsetMinute = Number(offsetMinuteRaw);
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }

  return true;
}

export function isInvalidIsoTimestampParam(value) {
  if (value === undefined || value === null || value === '') return false;
  if (typeof value !== 'string') return true;
  return !isValidIsoTimestamp(value);
}

export function enumParam(value, allowed, defaultValue) {
  if (typeof value !== 'string') return defaultValue;
  const normalized = value.trim().toLowerCase();
  return allowed.includes(normalized) ? normalized : defaultValue;
}

export function truthyParam(value) {
  if (value === true) return true;
  if (typeof value !== 'string') return false;
  return ['true', '1', 'yes', 'y', 'on'].includes(value.trim().toLowerCase());
}

export function requestHasOperatorApproval(req) {
  return truthyParam(req?.body?.operator_approved) || truthyParam(req?.query?.operator_approved);
}

export function falseyParam(value) {
  if (value === false) return true;
  if (typeof value !== 'string') return false;
  return ['false', '0', 'no', 'n', 'off'].includes(value.trim().toLowerCase());
}

export function isInvalidBooleanParam(value) {
  if (value === undefined || value === null || value === '') return false;
  if (typeof value === 'boolean') return false;
  if (typeof value !== 'string') return true;
  const normalized = value.trim().toLowerCase();
  return !['true', '1', 'yes', 'y', 'on', 'false', '0', 'no', 'n', 'off'].includes(normalized);
}
