import { debug } from '../utils/settings.js';
import {
  claimOutboundBucket,
  ensureOutboundTables,
  getLatestOutboundCarriers,
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
export const GLOBALPING_FETCH_TIMEOUT_MS = 8000;

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

export function measurementProbeCount(body) {
  const locations = Array.isArray(body?.locations) ? body.locations : [];
  return locations.reduce((sum, location) => sum + Number(location?.limit || 0), 0);
}

export function buildMeasurementRequest(items) {
  // No top-level limit: Globalping rejects locations[].limit when a global limit
  // is present, and the router only honors per-location limit when that field is set.
  const body = {
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
  if (Object.prototype.hasOwnProperty.call(body, 'limit')) {
    throw new Error('global limit would disable per-location limits');
  }
  if (measurementProbeCount(body) !== body.locations.length || body.locations.some(location => location.limit !== 1)) {
    throw new Error('each location must request exactly one probe');
  }
  return body;
}

export function nextCarrierAsn(asns, lastPoint) {
  const primary = asns[0];
  if (!lastPoint || (lastPoint.status !== 'gap' && lastPoint.status !== 'no_probes')) return primary;
  const index = asns.indexOf(Number(lastPoint.asn));
  if (index < 0 || index + 1 >= asns.length) return primary;
  return asns[index + 1];
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
      if (seen.has(carrier)) continue;
      const requestedAsn = requested.find(item => item?.carrier === carrier)?.asn ?? null;
      points.push({ ...gapPoint(carrier, timestamp, measurement.id || ''), asn: requestedAsn });
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

function isFetchTimeout(error) {
  const name = String(error?.name || '');
  return name === 'AbortError' || name === 'TimeoutError';
}

async function globalpingFetch(fetchImpl, summary, url, options = {}) {
  summary.requests += 1;
  const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(GLOBALPING_FETCH_TIMEOUT_MS)
    : undefined;
  let response;
  try {
    response = await fetchImpl(url, {
      method: options.method || 'GET',
      headers: {
        ...GLOBALPING_HEADERS,
        ...(options.body ? { 'Content-Type': 'application/json' } : {})
      },
      body: options.body,
      signal
    });
  } catch (error) {
    if (isFetchTimeout(error)) return { response: null, body: null, timeout: true };
    throw error;
  }
  const body = await readGlobalpingJson(response);
  return { response, body, timeout: false };
}

async function postLocations(fetchImpl, summary, items) {
  const payload = assertMainlandLocations(buildMeasurementRequest(items));
  const result = await globalpingFetch(fetchImpl, summary, `${GLOBALPING_API}/measurements`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  if (result.timeout || !result.response) return { timeout: true };
  const remaining = remainingCreateCredits(result.body, result.response.headers);
  const probesCount = Number(result.body?.probesCount);
  if ((result.response.status === 202 || result.response.status === 200) && result.body?.id) {
    return {
      ok: true,
      id: result.body.id,
      remaining,
      probesCount: Number.isFinite(probesCount) ? probesCount : items.length
    };
  }
  if (result.response.status === 429) return { rateLimited: true, remaining: 0 };
  if (isNoProbes(result.response.status, result.body)) return { noProbes: true, remaining };
  return { error: true, remaining };
}

function creditsAfter(credits, result, requestedProbes) {
  if (result.remaining !== null && result.remaining !== undefined) return result.remaining;
  const used = Number.isFinite(result.probesCount) ? result.probesCount : requestedProbes;
  return credits - used;
}

async function readLimits(fetchImpl, summary) {
  try {
    const result = await globalpingFetch(fetchImpl, summary, `${GLOBALPING_API}/limits`);
    if (result.timeout || !result.response) return { failed: true, timeout: true, remaining: null };
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

    if (result.timeout || !result.response) {
      kept.push(...items);
      break;
    }
    if (result.response.status === 404) {
      summary.stored += await saveOutboundPoints(
        db,
        OUTBOUND_SERVER_ID,
        items.map(item => ({ ...gapPoint(item.carrier, now, ''), asn: item.asn ?? null }))
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

async function placeCarriers(fetchImpl, summary, remaining, choices) {
  const placed = [];
  const gaps = [];
  const probeCount = choices.length;
  if (remaining !== null && remaining < probeCount) {
    return {
      placed,
      gaps: choices.map(item => item.carrier),
      rateLimited: true
    };
  }
  let credits = remaining === null ? probeCount : remaining;
  const combined = await postLocations(fetchImpl, summary, choices);
  if (combined.timeout) return { placed, gaps, rateLimited: false, timeout: true };
  if (combined.ok) {
    summary.posted += 1;
    return {
      placed: choices.map(item => ({ ...item, id: combined.id })),
      gaps,
      rateLimited: false
    };
  }
  if (combined.rateLimited || !combined.noProbes) {
    return {
      placed,
      gaps: choices.map(item => item.carrier),
      rateLimited: Boolean(combined.rateLimited)
    };
  }
  credits = creditsAfter(credits, combined, 0);

  for (const choice of choices) {
    const spec = OUTBOUND_CARRIERS.find(item => item.carrier === choice.carrier);
    const fallbacks = (spec?.asns || []).filter(asn => asn !== choice.asn);
    if (credits < 1) {
      gaps.push(choice.carrier);
      continue;
    }
    let placedCarrier = false;
    for (const asn of fallbacks) {
      if (credits < 1) break;
      const result = await postLocations(fetchImpl, summary, [{ carrier: choice.carrier, asn }]);
      if (result.timeout) {
        if (!placedCarrier) gaps.push(choice.carrier);
        for (const rest of choices.slice(choices.indexOf(choice) + 1)) gaps.push(rest.carrier);
        return { placed, gaps, rateLimited: false, timeout: true };
      }
      if (result.ok) {
        placed.push({ carrier: choice.carrier, asn, id: result.id });
        summary.posted += 1;
        credits = creditsAfter(credits, result, 1);
        placedCarrier = true;
        break;
      }
      if (result.rateLimited) {
        if (!placedCarrier) gaps.push(choice.carrier);
        for (const rest of choices.slice(choices.indexOf(choice) + 1)) gaps.push(rest.carrier);
        return { placed, gaps, rateLimited: true };
      }
      if (!result.noProbes) break;
      credits = creditsAfter(credits, result, 0);
    }
    if (!placedCarrier) gaps.push(choice.carrier);
  }
  return { placed, gaps, rateLimited: false };
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
    const claimed = await claimOutboundBucket(env.DB, bucket);
    if (!claimed) {
      summary.skipped = 'already_ran';
      return summary;
    }
    await pruneOutboundPoints(env.DB, OUTBOUND_SERVER_ID, now - OUTBOUND_RETENTION_MS);
    const state = await readOutboundState(env.DB);

    const limits = await readLimits(fetchImpl, summary);
    if (limits.failed) {
      await writeOutboundState(env.DB, bucket, state.pending);
      summary.skipped = limits.timeout ? 'timeout' : 'limits_unavailable';
      return summary;
    }
    if (limits.rateLimited || (limits.remaining !== null && limits.remaining < OUTBOUND_CARRIERS.length)) {
      await writeOutboundState(env.DB, bucket, state.pending);
      summary.skipped = 'rate_limit';
      return summary;
    }

    const persisted = await persistPending(env.DB, fetchImpl, summary, state.pending, now);
    if (persisted.rateLimited) {
      await writeOutboundState(env.DB, bucket, persisted.pending);
      summary.skipped = 'rate_limit';
      return summary;
    }
    if (persisted.pending.length >= OUTBOUND_MAX_PENDING) {
      await writeOutboundState(env.DB, bucket, persisted.pending);
      summary.skipped = 'pending_full';
      return summary;
    }

    const latest = await getLatestOutboundCarriers(env.DB, OUTBOUND_SERVER_ID);
    const latestByCarrier = new Map(latest.map(point => [point.carrier, point]));
    const choices = OUTBOUND_CARRIERS.map(item => ({
      carrier: item.carrier,
      asn: nextCarrierAsn(item.asns, latestByCarrier.get(item.carrier))
    }));
    const placed = await placeCarriers(fetchImpl, summary, limits.remaining, choices);
    if (placed.timeout) {
      await writeOutboundState(env.DB, bucket, [...persisted.pending, ...placed.placed]);
      summary.skipped = 'timeout';
      return summary;
    }
    if (placed.gaps.length > 0) {
      const asnByCarrier = new Map(choices.map(item => [item.carrier, item.asn]));
      summary.stored += await saveOutboundPoints(
        env.DB,
        OUTBOUND_SERVER_ID,
        placed.gaps.map(carrier => ({ ...gapPoint(carrier, now, ''), asn: asnByCarrier.get(carrier) ?? null }))
      );
    }
    const room = Math.max(0, OUTBOUND_MAX_PENDING - persisted.pending.length);
    const accepted = placed.placed.slice(0, room);
    await writeOutboundState(env.DB, bucket, [...persisted.pending, ...accepted]);
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
