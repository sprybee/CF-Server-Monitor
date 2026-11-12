import { debug } from '../utils/settings.js';
import {
  ensureOutboundTables,
  pruneOutboundPoints,
  readOutboundState,
  saveOutboundPoints,
  writeOutboundState
} from '../database/globalpingStore.js';

export const GLOBALPING_API = 'https://api.globalping.io/v1';
export const OUTBOUND_TARGET = '168.93.198.110';
export const OUTBOUND_SERVER_ID = '74a08d8d-19d7-4b7a-91bc-11506f6027f7';
export const OUTBOUND_INTERVAL_MS = 5 * 60 * 1000;
export const OUTBOUND_RETENTION_MS = 8 * 24 * 60 * 60 * 1000;
export const OUTBOUND_MAX_PENDING = 12;

export const GLOBALPING_HEADERS = Object.freeze({
  'User-Agent': 'cf-server-monitor/2.8.7 (+https://cf-server-monitor.eliamzhao.workers.dev)',
  Accept: 'application/json',
  'Accept-Encoding': 'gzip'
});

// Mainland eyeball ASNs only. Hong Kong, Macao, and Taiwan are never substitutes.
export const OUTBOUND_CARRIERS = Object.freeze([
  { carrier: 'ct', label: '电信', asns: Object.freeze([4134, 4812, 4811]) },
  { carrier: 'cu', label: '联通', asns: Object.freeze([4837, 9929, 17621]) },
  { carrier: 'cm', label: '移动', asns: Object.freeze([9808, 56041, 56048, 24445, 56045]) }
]);

const ASN_TO_CARRIER = new Map();
for (const item of OUTBOUND_CARRIERS) {
  for (const asn of item.asns) ASN_TO_CARRIER.set(asn, item.carrier);
}

const FORBIDDEN_LOCATION = /(?:^|[^A-Za-z])(HK|MO|TW)(?:[^A-Za-z]|$)|hong\s*kong|macau|macao|taiwan/i;

export function carrierForAsn(asn) {
  return ASN_TO_CARRIER.get(Number(asn)) || null;
}

export function isGlobalpingOutboundSlot(timestamp) {
  const time = Number(timestamp);
  if (!Number.isFinite(time) || time <= 0) return false;
  return Math.floor(time / 60000) % 5 === 0;
}

export function outboundBucket(timestamp) {
  return Math.floor(Number(timestamp) / OUTBOUND_INTERVAL_MS);
}

export function buildMeasurementRequest(items) {
  return {
    type: 'ping',
    target: OUTBOUND_TARGET,
    inProgressUpdates: false,
    timeout: 10,
    locations: (items || []).map(item => ({
      country: 'CN',
      asn: item.asn,
      tags: ['eyeball-network'],
      limit: 1
    })),
    measurementOptions: {
      packets: 3,
      protocol: 'TCP',
      port: 443
    }
  };
}

export function assertMainlandLocations(body) {
  const locations = body?.locations;
  if (!Array.isArray(locations) || locations.length === 0) {
    throw new Error('measurement has no locations');
  }
  for (const location of locations) {
    if (!location || location.country !== 'CN' || location.magic || Object.prototype.hasOwnProperty.call(location, 'network')) {
      throw new Error('refusing non-mainland location');
    }
    if (!Number.isInteger(location.asn) || !carrierForAsn(location.asn)) {
      throw new Error('refusing non-mainland location');
    }
    if (FORBIDDEN_LOCATION.test(JSON.stringify(location))) {
      throw new Error('refusing non-mainland location');
    }
  }
  return body;
}

export function remainingCreateCredits(limitsBody, headers) {
  const values = [];
  const headerValue = headers?.get?.('x-ratelimit-remaining') ?? headers?.get?.('X-RateLimit-Remaining');
  if (headerValue !== null && headerValue !== undefined && headerValue !== '') {
    const parsed = Number(headerValue);
    if (Number.isFinite(parsed)) values.push(parsed);
  }
  const bodyValue = limitsBody?.rateLimit?.measurements?.create?.remaining;
  if (bodyValue !== null && bodyValue !== undefined && bodyValue !== '') {
    const parsed = Number(bodyValue);
    if (Number.isFinite(parsed)) values.push(parsed);
  }
  if (values.length === 0) return null;
  return Math.min(...values);
}

export function gapPoint(carrier, createdAt, measurementId = '') {
  return {
    measurement_id: String(measurementId || ''),
    created_at: createdAt,
    carrier,
    asn: null,
    city: '',
    network: '',
    tags: [],
    avg: null,
    min: null,
    max: null,
    loss: null,
    rcv: null,
    drop: null,
    total: null,
    status: 'gap',
    probe_country: null
  };
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function pointsFromMeasurement(measurement, requested = []) {
  const createdAt = Date.parse(measurement?.createdAt || '');
  const timestamp = Number.isFinite(createdAt) ? createdAt : Date.now();
  const requestedCarriers = [...new Set(requested.map(item => item?.carrier).filter(Boolean))];
  const seen = new Set();
  const points = [];

  for (const item of measurement?.results || []) {
    const probe = item?.probe;
    if (!probe || probe.country !== 'CN') continue;
    const carrier = carrierForAsn(probe.asn);
    if (!carrier || seen.has(carrier)) continue;
    if (requestedCarriers.length > 0 && !requestedCarriers.includes(carrier)) continue;
    seen.add(carrier);
    const result = item.result || {};
    const stats = result.stats || {};
    const status = result.status || measurement.status || '';
    const timedOut = status !== 'finished';
    points.push({
      measurement_id: String(measurement.id || ''),
      created_at: timestamp,
      carrier,
      asn: Number(probe.asn),
      city: String(probe.city || '').slice(0, 120),
      network: String(probe.network || '').slice(0, 160),
      tags: Array.isArray(probe.tags) ? probe.tags.slice(0, 12).map(tag => String(tag).slice(0, 80)) : [],
      avg: timedOut ? null : numberOrNull(stats.avg),
      min: timedOut ? null : numberOrNull(stats.min),
      max: timedOut ? null : numberOrNull(stats.max),
      loss: timedOut ? null : numberOrNull(stats.loss),
      rcv: timedOut ? null : numberOrNull(stats.rcv),
      drop: timedOut ? null : numberOrNull(stats.drop),
      total: timedOut ? null : numberOrNull(stats.total),
      status: timedOut ? (status || 'timeout') : 'finished',
      probe_country: 'CN'
    });
  }

  if (measurement?.status === 'finished') {
    for (const carrier of requestedCarriers) {
      if (!seen.has(carrier)) points.push(gapPoint(carrier, timestamp, measurement.id || ''));
    }
  }
  return points;
}

export async function readGlobalpingJson(response) {
  const encoding = String(response.headers?.get?.('content-encoding') || '').toLowerCase();
  let text = '';
  if (encoding.includes('gzip') && response.body && typeof DecompressionStream === 'function') {
    text = await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).text();
  } else if (typeof response.text === 'function') {
    text = await response.text();
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isNoProbes(status, body) {
  return status === 422 && (body?.error?.type === 'no_probes_found' || body?.type === 'no_probes_found');
}

async function globalpingFetch(fetchImpl, summary, url, options = {}) {
  summary.requests += 1;
  const response = await fetchImpl(url, {
    method: options.method || 'GET',
    headers: {
      ...GLOBALPING_HEADERS,
      ...(options.body ? { 'Content-Type': 'application/json' } : {})
    },
    body: options.body
  });
  const body = await readGlobalpingJson(response);
  return { response, body };
}

async function postLocations(fetchImpl, summary, items) {
  const payload = assertMainlandLocations(buildMeasurementRequest(items));
  const result = await globalpingFetch(fetchImpl, summary, `${GLOBALPING_API}/measurements`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  const remaining = remainingCreateCredits(result.body, result.response.headers);
  if ((result.response.status === 202 || result.response.status === 200) && result.body?.id) {
    return { ok: true, id: result.body.id, remaining };
  }
  if (result.response.status === 429) return { rateLimited: true, remaining: 0 };
  if (isNoProbes(result.response.status, result.body)) return { noProbes: true, remaining };
  return { error: true, remaining };
}

async function readLimits(fetchImpl, summary) {
  try {
    const result = await globalpingFetch(fetchImpl, summary, `${GLOBALPING_API}/limits`);
    if (result.response.status === 429) return { rateLimited: true, remaining: 0 };
    if (!result.response.ok) return { failed: true, remaining: null };
    const remaining = remainingCreateCredits(result.body, result.response.headers);
    if (remaining !== null && remaining < 1) return { rateLimited: true, remaining };
    return { remaining };
  } catch (error) {
    debug('[Globalping] limits fetch failed', error?.message || error);
    return { failed: true, remaining: null };
  }
}

async function persistPending(db, fetchImpl, summary, pending, now) {
  const groups = new Map();
  for (const item of pending) {
    if (!item?.id || !item.carrier) continue;
    const list = groups.get(item.id) || [];
    list.push(item);
    groups.set(item.id, list);
  }

  const kept = [];
  let rateLimited = false;
  for (const [id, items] of groups) {
    if (rateLimited) {
      kept.push(...items);
      continue;
    }
    let result;
    try {
      result = await globalpingFetch(
        fetchImpl,
        summary,
        `${GLOBALPING_API}/measurements/${encodeURIComponent(id)}`
      );
    } catch (error) {
      debug('[Globalping] measurement fetch failed', error?.message || error);
      kept.push(...items);
      continue;
    }

    if (result.response.status === 404) {
      summary.stored += await saveOutboundPoints(
        db,
        OUTBOUND_SERVER_ID,
        items.map(item => gapPoint(item.carrier, now, ''))
      );
      continue;
    }
    if (result.response.status === 429) {
      rateLimited = true;
      kept.push(...items);
      continue;
    }
    if (!result.response.ok || !result.body) {
      kept.push(...items);
      continue;
    }
    if (result.body.status === 'in-progress') {
      kept.push(...items);
      continue;
    }
    const points = pointsFromMeasurement(result.body, items);
    summary.stored += await saveOutboundPoints(db, OUTBOUND_SERVER_ID, points);
  }
  return { pending: kept, rateLimited };
}

async function placeCarriers(fetchImpl, summary, remaining) {
  const placed = [];
  const gaps = [];
  let credits = remaining === null ? OUTBOUND_CARRIERS.length : remaining;

  if (credits >= OUTBOUND_CARRIERS.length) {
    const primary = OUTBOUND_CARRIERS.map(item => ({ carrier: item.carrier, asn: item.asns[0] }));
    const result = await postLocations(fetchImpl, summary, primary);
    if (result.ok) {
      for (const item of primary) placed.push({ ...item, id: result.id });
      summary.posted += 1;
      return { placed, gaps, rateLimited: false };
    }
    if (result.rateLimited) {
      return {
        placed,
        gaps: OUTBOUND_CARRIERS.map(item => item.carrier),
        rateLimited: true
      };
    }
    if (!result.noProbes) {
      return {
        placed,
        gaps: OUTBOUND_CARRIERS.map(item => item.carrier),
        rateLimited: false
      };
    }
    if (result.remaining !== null && result.remaining !== undefined) credits = result.remaining;
  }

  for (const spec of OUTBOUND_CARRIERS) {
    if (credits < 1) {
      gaps.push(spec.carrier);
      continue;
    }
    let placedCarrier = false;
    for (const asn of spec.asns) {
      if (credits < 1) break;
      const result = await postLocations(fetchImpl, summary, [{ carrier: spec.carrier, asn }]);
      if (result.ok) {
        placed.push({ carrier: spec.carrier, asn, id: result.id });
        summary.posted += 1;
        credits = result.remaining === null || result.remaining === undefined ? credits - 1 : result.remaining;
        placedCarrier = true;
        break;
      }
      if (result.rateLimited) {
        if (!placedCarrier) gaps.push(spec.carrier);
        for (const rest of OUTBOUND_CARRIERS.slice(OUTBOUND_CARRIERS.indexOf(spec) + 1)) {
          gaps.push(rest.carrier);
        }
        return { placed, gaps, rateLimited: true };
      }
      if (!result.noProbes) break;
      if (result.remaining !== null && result.remaining !== undefined) credits = result.remaining;
    }
    if (!placedCarrier) gaps.push(spec.carrier);
  }
  return { placed, gaps, rateLimited: false };
}

function capPending(pending) {
  if (pending.length <= OUTBOUND_MAX_PENDING) return { pending, dropped: [] };
  return {
    pending: pending.slice(pending.length - OUTBOUND_MAX_PENDING),
    dropped: pending.slice(0, pending.length - OUTBOUND_MAX_PENDING)
  };
}

export async function runGlobalpingOutbound(env, now = Date.now(), deps = {}) {
  const summary = { skipped: '', posted: 0, stored: 0, requests: 0 };
  const fetchImpl = deps.fetchImpl || fetch;
  try {
    if (!env?.DB) {
      summary.skipped = 'no_database';
      return summary;
    }
    const bucket = outboundBucket(now);
    await ensureOutboundTables(env.DB);
    await pruneOutboundPoints(env.DB, OUTBOUND_SERVER_ID, now - OUTBOUND_RETENTION_MS);
    const state = await readOutboundState(env.DB);
    if (state.bucket === bucket) {
      summary.skipped = 'already_ran';
      return summary;
    }

    const limits = await readLimits(fetchImpl, summary);
    if (limits.rateLimited || limits.failed) {
      if (limits.rateLimited) {
        summary.stored += await saveOutboundPoints(
          env.DB,
          OUTBOUND_SERVER_ID,
          OUTBOUND_CARRIERS.map(item => gapPoint(item.carrier, now, ''))
        );
      }
      await writeOutboundState(env.DB, bucket, state.pending);
      summary.skipped = limits.rateLimited ? 'rate_limit' : 'limits_unavailable';
      return summary;
    }

    const persisted = await persistPending(env.DB, fetchImpl, summary, state.pending, now);
    if (persisted.rateLimited) {
      await writeOutboundState(env.DB, bucket, persisted.pending);
      summary.skipped = 'rate_limit';
      return summary;
    }

    const placed = await placeCarriers(fetchImpl, summary, limits.remaining);
    if (placed.gaps.length > 0) {
      summary.stored += await saveOutboundPoints(
        env.DB,
        OUTBOUND_SERVER_ID,
        placed.gaps.map(carrier => gapPoint(carrier, now, ''))
      );
    }
    const capped = capPending([...persisted.pending, ...placed.placed]);
    if (capped.dropped.length > 0) {
      summary.stored += await saveOutboundPoints(
        env.DB,
        OUTBOUND_SERVER_ID,
        capped.dropped.map(item => gapPoint(item.carrier, now, ''))
      );
    }
    await writeOutboundState(env.DB, bucket, capped.pending);
    if (placed.rateLimited) summary.skipped = 'rate_limit';
    return summary;
  } catch (error) {
    console.error(JSON.stringify({
      source: 'globalping-outbound',
      event: 'round_failed',
      message: error?.message || String(error)
    }));
    summary.skipped = summary.skipped || 'error';
    return summary;
  }
}
