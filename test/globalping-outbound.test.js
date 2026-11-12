import assert from 'node:assert/strict';
import test from 'node:test';
import { Miniflare } from 'miniflare';

import worker from '../src/index.js';
import { clearServerDetailCache } from '../src/utils/cache.js';
import { clearSiteSettingsCache } from '../src/utils/settings.js';
import {
  ensureOutboundTables,
  getOutboundHistory,
  readOutboundState,
  saveOutboundPoints,
  writeOutboundState
} from '../src/database/globalpingStore.js';
import {
  OUTBOUND_CARRIERS,
  OUTBOUND_SERVER_ID,
  OUTBOUND_TARGET,
  assertMainlandLocations,
  buildMeasurementRequest,
  gapPoint,
  isGlobalpingOutboundSlot,
  measurementProbeCount,
  nextCarrierAsn,
  pointsFromMeasurement,
  readGlobalpingJson,
  runGlobalpingOutbound
} from '../src/services/globalpingOutbound.js';
import { outboundLossValue, outboundPingValue } from '../src/frontend/utils/outboundLatency.js';
import {
  attachOutboundPoints,
  buildOutboundChartSeries
} from '../src/frontend/utils/outboundLatency.js';

const JWT_SECRET = 'x'.repeat(32);
const ALLOWED_ASNS = new Set(OUTBOUND_CARRIERS.flatMap(item => item.asns));

function createMiniflare(name) {
  return new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } }',
    d1Databases: { DB: name }
  });
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  });
}

function limitsBody(remaining) {
  return {
    rateLimit: {
      measurements: {
        create: { type: 'ip', limit: 250, remaining, reset: 1800 }
      }
    }
  };
}

function assertMainlandRequest(body) {
  const parsed = typeof body === 'string' ? JSON.parse(body) : body;
  assertMainlandLocations(parsed);
  assert.equal(parsed.target, OUTBOUND_TARGET);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'limit'), false);
  assert.equal(measurementProbeCount(parsed), parsed.locations.length);
  assert.equal(parsed.locations.every(location => location.limit === 1), true);
  assert.equal(parsed.inProgressUpdates, false);
  assert.equal(parsed.measurementOptions.protocol, 'TCP');
  assert.equal(parsed.measurementOptions.port, 443);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'magic'), false);
  for (const location of parsed.locations) {
    assert.equal(location.country, 'CN');
    assert.equal(Object.prototype.hasOwnProperty.call(location, 'magic'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(location, 'network'), false);
    assert.equal(ALLOWED_ASNS.has(location.asn), true);
    assert.equal(['HK', 'MO', 'TW'].includes(location.country), false);
  }
  return parsed;
}

async function createMetricsTable(db) {
  await db.prepare(`
    CREATE TABLE metrics_history (
      id INTEGER PRIMARY KEY,
      server_id TEXT,
      timestamp INTEGER,
      cpu REAL,
      ram_total REAL,
      ram_used REAL,
      disk_total REAL,
      disk_used REAL,
      ping_ct INTEGER,
      net_rx REAL,
      net_tx REAL
    )
  `).run();
  await db.prepare(`
    INSERT INTO metrics_history (
      id, server_id, timestamp, cpu, ram_total, ram_used, disk_total, disk_used, ping_ct, net_rx, net_tx
    ) VALUES (1, ?, 1700000000000, 12.5, 1024, 256, 20480, 4096, 33, 900, 450)
  `).bind(OUTBOUND_SERVER_ID).run();
}

async function seedServer(db, isPublic) {
  await db.prepare('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)').run();
  await db.prepare('CREATE TABLE servers (id TEXT PRIMARY KEY, name TEXT, is_hidden TEXT, history_partition_id INTEGER, timestamp INTEGER)').run();
  await db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?)'
  ).bind('site_options', JSON.stringify({
    is_public: isPublic ? 'true' : 'false',
    auto_discovery: 'false',
    jwt_secret: JWT_SECRET,
    turnstile_enabled: 'false'
  })).run();
  await db.prepare(
    'INSERT INTO servers (id, name, is_hidden, history_partition_id, timestamp) VALUES (?, ?, ?, ?, ?)'
  ).bind(OUTBOUND_SERVER_ID, 'my-vps', '0', 1, Date.now()).run();
}

test('five-minute gate follows the cron timestamp and skips other minutes', () => {
  assert.equal(isGlobalpingOutboundSlot(Date.UTC(2026, 10, 12, 3, 0, 0)), true);
  assert.equal(isGlobalpingOutboundSlot(Date.UTC(2026, 10, 12, 3, 5, 40)), true);
  assert.equal(isGlobalpingOutboundSlot(Date.UTC(2026, 10, 12, 3, 4, 59)), false);
  assert.equal(isGlobalpingOutboundSlot(Date.UTC(2026, 9, 22, 12, 2)), false);
  assert.equal(isGlobalpingOutboundSlot(0), false);
});

test('measurement locations stay on mainland China ASNs', () => {
  const body = buildMeasurementRequest(OUTBOUND_CARRIERS.map(item => ({ asn: item.asns[0] })));
  assertMainlandRequest(body);
  assert.equal(body.locations.length, 3);
  assert.equal(measurementProbeCount(body), 3);
  assert.equal(nextCarrierAsn([4134, 4812, 4811], { status: 'gap', asn: 4134 }), 4812);
  assert.equal(nextCarrierAsn([4134, 4812, 4811], { status: 'finished', asn: 4812 }), 4134);
  assert.throws(() => assertMainlandLocations({
    locations: [{ country: 'HK', asn: 4134, tags: ['eyeball-network'], limit: 1 }]
  }));
  assert.throws(() => assertMainlandLocations({
    locations: [{ country: 'CN', magic: 'China', asn: 4134, limit: 1 }]
  }));
});

test('non-CN probes are dropped and timeouts become null', () => {
  const points = pointsFromMeasurement({
    id: 'm1',
    status: 'finished',
    createdAt: '2026-11-12T03:00:00.000Z',
    results: [
      {
        probe: { country: 'CN', asn: 4134, city: 'Shanghai', network: 'Chinanet', tags: ['eyeball-network'] },
        result: { status: 'finished', stats: { avg: 41.2, min: 40, max: 43, loss: 0, rcv: 3, drop: 0, total: 3 } }
      },
      {
        probe: { country: 'HK', asn: 4837, city: 'Hong Kong', network: 'HKT', tags: ['eyeball-network'] },
        result: { status: 'finished', stats: { avg: 5, min: 5, max: 5, loss: 0, rcv: 3, drop: 0, total: 3 } }
      },
      {
        probe: { country: 'CN', asn: 9808, city: 'Guangzhou', network: 'CMNET', tags: ['eyeball-network'] },
        result: { status: 'failed' }
      },
      {
        probe: { country: 'TW', asn: 4134, city: 'Taipei', network: 'HiNet', tags: [] },
        result: { status: 'finished', stats: { avg: 9, min: 9, max: 9, loss: 0, rcv: 3, drop: 0, total: 3 } }
      }
    ]
  }, [
    { carrier: 'ct', asn: 4134 },
    { carrier: 'cu', asn: 4837 },
    { carrier: 'cm', asn: 9808 }
  ]);

  assert.deepEqual(points.map(point => [point.carrier, point.probe_country, point.status, point.avg]), [
    ['ct', 'CN', 'finished', 41.2],
    ['cm', 'CN', 'failed', null],
    ['cu', null, 'gap', null]
  ]);
  assert.equal(points.find(point => point.carrier === 'ct').city, 'Shanghai');
  assert.equal(points.find(point => point.carrier === 'ct').asn, 4134);
  assert.equal(points.some(point => point.city === 'Hong Kong' || point.city === 'Taipei' || point.probe_country === 'HK' || point.probe_country === 'TW'), false);
});

test('disabled and missing outbound series stay hidden and timeouts are null', () => {
  assert.equal(buildOutboundChartSeries([], 'ct').hidden, true);
  const disabled = buildOutboundChartSeries([
    { timestamp: 1_000, carrier: 'ct', avg: 20, status: 'finished' },
    { timestamp: 2_000, carrier: 'ct', avg: false, status: 'disabled' }
  ], 'ct');
  assert.equal(disabled.hidden, true);
  assert.deepEqual(disabled.rows, []);

  const timeout = buildOutboundChartSeries([
    { timestamp: 1_000, carrier: 'cu', avg: 30, loss: 0, status: 'finished' },
    { timestamp: 2_000, carrier: 'cu', avg: null, loss: null, status: 'timeout' }
  ], 'cu');
  assert.equal(timeout.hidden, false);
  assert.deepEqual(timeout.rows.map(row => row.y), [30, null]);
  assert.deepEqual(timeout.rows.map(row => row.loss), [0, null]);
  assert.equal(outboundPingValue({ status: 'finished', avg: 0, loss: 100 }), null);
  assert.equal(outboundPingValue({ status: 'finished', avg: null, loss: null }), null);
  assert.equal(outboundLossValue({ status: 'finished', avg: null, loss: null }), null);
  assert.equal(outboundLossValue({ status: 'timeout', avg: null, loss: 100 }), null);

  const server = { ping: [{ ts: 1, ct: 12, cu: 13, cm: 14 }], loss: [{ ts: 1, ct: 0 }] };
  attachOutboundPoints(server, [{ timestamp: 2, carrier: 'ct', avg: 40, status: 'finished' }]);
  assert.deepEqual(server.ping, [{ ts: 1, ct: 12, cu: 13, cm: 14 }]);
  assert.deepEqual(server.loss, [{ ts: 1, ct: 0 }]);
  assert.equal(server.outbound.points[0].carrier, 'ct');
});

test('saving Globalping points leaves agent host-metric rows intact', async () => {
  const miniflare = createMiniflare('globalping-metrics');
  try {
    const db = await miniflare.getD1Database('DB');
    await createMetricsTable(db);
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
      calls.push({ url: String(url), body: options.body || '' });
      if (String(url).endsWith('/limits')) {
        return jsonResponse(limitsBody(200), 200, { 'X-RateLimit-Remaining': '200' });
      }
      if (String(url).endsWith('/measurements')) {
        assertMainlandRequest(options.body);
        return jsonResponse({ id: 'next-id', probesCount: 3 }, 202, { 'X-RateLimit-Remaining': '197' });
      }
      throw new Error(`unexpected ${url}`);
    };

    await saveOutboundPoints(db, OUTBOUND_SERVER_ID, [
      { ...gapPoint('ct', 1_700_000_100_000, 'gap-1'), status: 'timeout', avg: null }
    ]);
    const summary = await runGlobalpingOutbound({ DB: db }, Date.UTC(2026, 10, 12, 3, 5), { fetchImpl });
    assert.equal(summary.skipped, '');
    assert.equal(summary.posted, 1);
    assert.equal(calls.every(call => call.url.startsWith('https://api.globalping.io/')), true);

    const rows = await db.prepare('SELECT * FROM metrics_history').all();
    assert.equal(rows.results.length, 1);
    assert.equal(rows.results[0].cpu, 12.5);
    assert.equal(rows.results[0].ram_used, 256);
    assert.equal(rows.results[0].disk_used, 4096);
    assert.equal(rows.results[0].ping_ct, 33);
    assert.equal(rows.results[0].net_rx, 900);
    assert.equal(rows.results[0].net_tx, 450);
  } finally {
    await miniflare.dispose();
  }
});

test('429, no_probes_found, and a missing previous id do not throw or use HK', async () => {
  const miniflare = createMiniflare('globalping-errors');
  try {
    const db = await miniflare.getD1Database('DB');
    await ensureOutboundTables(db);
    await writeOutboundState(db, null, [
      { id: 'missing-id', carrier: 'ct', asn: 4134 },
      { id: 'missing-id', carrier: 'cu', asn: 4837 },
      { id: 'missing-id', carrier: 'cm', asn: 9808 }
    ]);

    const limited = await runGlobalpingOutbound({ DB: db }, Date.UTC(2026, 10, 12, 4, 0), {
      fetchImpl: async (url) => {
        assert.equal(String(url).endsWith('/limits'), true);
        return jsonResponse(limitsBody(0), 200, { 'X-RateLimit-Remaining': '0' });
      }
    });
    assert.equal(limited.skipped, 'rate_limit');
    assert.equal(limited.posted, 0);

    const blockedCalls = [];
    const blocked = await runGlobalpingOutbound({ DB: db }, Date.UTC(2026, 10, 12, 4, 5), {
      fetchImpl: async (url, options = {}) => {
        blockedCalls.push({ url: String(url), body: options.body || '' });
        if (String(url).endsWith('/limits')) return jsonResponse(limitsBody(0), 429);
        throw new Error(`unexpected ${url}`);
      }
    });
    assert.equal(blocked.skipped, 'rate_limit');
    assert.equal(blockedCalls.length, 1);

    const probeCalls = [];
    const noProbes = await runGlobalpingOutbound({ DB: db }, Date.UTC(2026, 10, 12, 4, 10), {
      fetchImpl: async (url, options = {}) => {
        probeCalls.push({ url: String(url), body: options.body || '' });
        if (String(url).endsWith('/limits')) {
          return jsonResponse(limitsBody(100), 200, { 'X-RateLimit-Remaining': '100' });
        }
        if (String(url).includes('/measurements/missing-id')) return jsonResponse({ error: { type: 'not_found' } }, 404);
        if (String(url).endsWith('/measurements')) {
          assertMainlandRequest(options.body);
          return jsonResponse({
            error: { type: 'no_probes_found', message: 'No matching probes available.' }
          }, 422);
        }
        throw new Error(`unexpected ${url}`);
      }
    });
    assert.notEqual(noProbes.skipped, 'error');
    assert.equal(probeCalls.some(call => /"country":"HK"|"country":"MO"|"country":"TW"|"magic"/.test(call.body)), false);
    const posted = probeCalls.filter(call => call.body);
    assert.equal(posted.length, 1 + 2 + 2 + 4);
    assert.equal(posted.filter(call => measurementProbeCount(JSON.parse(call.body)) > 1).length, 1);
    assert.equal(posted.every(call => measurementProbeCount(JSON.parse(call.body)) <= 3), true);
    const gaps = (await getOutboundHistory(db, OUTBOUND_SERVER_ID, 0)).filter(point => point.status === 'gap');
    assert.equal(gaps.some(point => point.carrier === 'ct'), true);
    assert.equal(gaps.some(point => point.carrier === 'cu'), true);
    assert.equal(gaps.some(point => point.carrier === 'cm'), true);

    await writeOutboundState(db, null, [{ id: 'still-missing', carrier: 'ct', asn: 4134 }]);
    const recovered = await runGlobalpingOutbound({ DB: db }, Date.UTC(2026, 10, 12, 4, 15), {
      fetchImpl: async (url, options = {}) => {
        if (String(url).endsWith('/limits')) return jsonResponse(limitsBody(20), 200, { 'X-RateLimit-Remaining': '20' });
        if (String(url).includes('/measurements/still-missing')) return jsonResponse({}, 404);
        if (String(url).endsWith('/measurements')) {
          assertMainlandRequest(options.body);
          return jsonResponse({ id: 'created-id', probesCount: 3 }, 202);
        }
        throw new Error(`unexpected ${url}`);
      }
    });
    assert.equal(recovered.posted, 1);
    const state = await readOutboundState(db);
    assert.equal(state.pending.every(item => item.id === 'created-id'), true);
    assert.equal(new Set(state.pending.map(item => item.carrier)).size, 3);
    assert.equal(state.pending.every(item => ALLOWED_ASNS.has(item.asn)), true);
    assert.equal(gaps.every(point => point.avg === null && point.loss === null), true);
  } finally {
    await miniflare.dispose();
  }
});

test('history API returns outbound points and private mode still denies anonymous access', async () => {
  clearSiteSettingsCache();
  clearServerDetailCache();
  const miniflare = createMiniflare('globalping-history');
  try {
    const db = await miniflare.getD1Database('DB');
    await seedServer(db, false);
    const env = { API_SECRET: 'test-secret', DB: db };
    const createdAt = Date.UTC(2026, 10, 12, 1, 0, 0);
    await saveOutboundPoints(db, OUTBOUND_SERVER_ID, [{
      measurement_id: 'hist-1',
      created_at: createdAt,
      carrier: 'ct',
      asn: 4134,
      city: 'Shanghai',
      network: 'Chinanet',
      tags: ['eyeball-network'],
      avg: 44.6,
      min: 40,
      max: 49,
      loss: 0,
      rcv: 3,
      drop: 0,
      total: 3,
      status: 'finished',
      probe_country: 'CN'
    }]);

    for (const path of [
      `/api/history/outbound?id=${OUTBOUND_SERVER_ID}&hours=1`,
      `/api/history/all?id=${OUTBOUND_SERVER_ID}&hours=1`,
      '/api/servers',
      `/api/server?id=${OUTBOUND_SERVER_ID}`
    ]) {
      const response = await worker.fetch(new Request(`https://monitor.example${path}`), env);
      assert.equal(response.status, 401, path);
    }

    clearSiteSettingsCache();
    clearServerDetailCache();
    await db.prepare('UPDATE settings SET value = ? WHERE key = ?').bind(JSON.stringify({
      is_public: 'true',
      auto_discovery: 'false',
      jwt_secret: JWT_SECRET,
      turnstile_enabled: 'false'
    }), 'site_options').run();

    const response = await worker.fetch(
      new Request(`https://monitor.example/api/history/outbound?id=${OUTBOUND_SERVER_ID}&hours=24`),
      env
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.length, 1);
    assert.equal(payload[0].measurement_id, 'hist-1');
    assert.equal(payload[0].carrier, 'ct');
    assert.equal(payload[0].asn, 4134);
    assert.equal(payload[0].city, 'Shanghai');
    assert.equal(payload[0].network, 'Chinanet');
    assert.deepEqual(payload[0].tags, ['eyeball-network']);
    assert.equal(payload[0].avg, 44.6);
    assert.equal(payload[0].min, 40);
    assert.equal(payload[0].max, 49);
    assert.equal(payload[0].loss, 0);
    assert.equal(payload[0].rcv, 3);
    assert.equal(payload[0].drop, 0);
    assert.equal(payload[0].total, 3);
    assert.equal(payload[0].status, 'finished');
    assert.equal(payload[0].probe_country, 'CN');
    assert.equal(payload[0].timestamp, createdAt);

    const metrics = await db.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?')
      .bind('table', 'metrics_history').first();
    assert.equal(metrics, null);
  } finally {
    clearSiteSettingsCache();
    clearServerDetailCache();
    await miniflare.dispose();
  }
});

test('a gap advances only that carrier to the next mainland ASN', async () => {
  const miniflare = createMiniflare('globalping-asn');
  try {
    const db = await miniflare.getD1Database('DB');
    await saveOutboundPoints(db, OUTBOUND_SERVER_ID, [
      { ...gapPoint('ct', Date.UTC(2026, 10, 12, 6, 0), ''), asn: 4134 }
    ]);
    let body = null;
    const summary = await runGlobalpingOutbound({ DB: db }, Date.UTC(2026, 10, 12, 6, 5), {
      fetchImpl: async (url, options = {}) => {
        if (String(url).endsWith('/limits')) return jsonResponse(limitsBody(10), 200, { 'X-RateLimit-Remaining': '10' });
        if (String(url).endsWith('/measurements')) {
          body = JSON.parse(options.body);
          return jsonResponse({ id: 'advanced', probesCount: 3 }, 202, { 'X-RateLimit-Remaining': '7' });
        }
        throw new Error(`unexpected ${url}`);
      }
    });
    assert.equal(summary.posted, 1);
    assert.equal(measurementProbeCount(body), 3);
    assert.deepEqual(body.locations.map(location => location.asn).sort((a, b) => a - b), [4812, 4837, 9808]);
  } finally {
    await miniflare.dispose();
  }
});

test('a second isolate does not post, in-progress ids stay pending, and quota failures do not write server config', async () => {
  const miniflare = createMiniflare('globalping-safety');
  try {
    const db = await miniflare.getD1Database('DB');
    await db.prepare('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)').run();
    await db.prepare('CREATE TABLE servers (id TEXT PRIMARY KEY, name TEXT, traffic_limit TEXT, net_rx_monthly REAL)').run();
    await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').bind('site_options', JSON.stringify({
      is_public: 'false',
      auto_discovery: 'false',
      traffic_limit: 'leave-me'
    })).run();
    await db.prepare('INSERT INTO servers (id, name, traffic_limit, net_rx_monthly) VALUES (?, ?, ?, ?)')
      .bind(OUTBOUND_SERVER_ID, 'my-vps', '250', 12345).run();
    await ensureOutboundTables(db);
    await writeOutboundState(db, null, [
      { id: 'inflight', carrier: 'ct', asn: 4134 },
      { id: 'inflight', carrier: 'cu', asn: 4837 },
      { id: 'inflight', carrier: 'cm', asn: 9808 }
    ]);

    let posts = 0;
    const fetchImpl = async (url, options = {}) => {
      if (String(url).endsWith('/limits')) return jsonResponse(limitsBody(40), 200, { 'X-RateLimit-Remaining': '40' });
      if (String(url).includes('/measurements/inflight')) {
        return jsonResponse({
          id: 'inflight',
          status: 'in-progress',
          createdAt: '2026-11-12T05:00:00.000Z',
          results: []
        });
      }
      if (String(url).endsWith('/measurements')) {
        posts += 1;
        const body = JSON.parse(options.body);
        assert.equal(measurementProbeCount(body), 3);
        return jsonResponse({ id: 'round-2', probesCount: 3 }, 202, { 'X-RateLimit-Remaining': '37' });
      }
      throw new Error(`unexpected ${url}`);
    };

    const now = Date.UTC(2026, 10, 12, 5, 0);
    const [first, second] = await Promise.all([
      runGlobalpingOutbound({ DB: db }, now, { fetchImpl }),
      runGlobalpingOutbound({ DB: db }, now, { fetchImpl })
    ]);
    assert.equal(posts, 1);
    assert.equal([first.skipped, second.skipped].filter(value => value === 'already_ran').length, 1);
    const pending = (await readOutboundState(db)).pending;
    assert.equal(pending.some(item => item.id === 'inflight'), true);
    assert.equal(pending.some(item => item.id === 'round-2'), true);

    const starved = await runGlobalpingOutbound({ DB: db }, Date.UTC(2026, 10, 12, 5, 5), {
      fetchImpl: async (url) => {
        assert.equal(String(url).endsWith('/limits'), true);
        return jsonResponse(limitsBody(2), 200, { 'X-RateLimit-Remaining': '2' });
      }
    });
    assert.equal(starved.posted, 0);
    assert.equal(starved.skipped, 'rate_limit');
    assert.equal((await readOutboundState(db)).pending.some(item => item.id === 'inflight'), true);

    const unavailable = await runGlobalpingOutbound({ DB: db }, Date.UTC(2026, 10, 12, 5, 10), {
      fetchImpl: async () => jsonResponse({ error: { type: 'server_error' } }, 500)
    });
    assert.equal(unavailable.posted, 0);
    assert.equal(unavailable.skipped, 'limits_unavailable');

    const timedOut = await runGlobalpingOutbound({ DB: db }, Date.UTC(2026, 10, 12, 5, 15), {
      fetchImpl: async () => {
        const error = new Error('timed out');
        error.name = 'TimeoutError';
        throw error;
      }
    });
    assert.equal(timedOut.posted, 0);
    assert.equal(timedOut.skipped, 'timeout');
    assert.equal((await readOutboundState(db)).pending.some(item => item.id === 'inflight'), true);

    const server = await db.prepare('SELECT traffic_limit, net_rx_monthly FROM servers WHERE id = ?').bind(OUTBOUND_SERVER_ID).first();
    assert.equal(server.traffic_limit, '250');
    assert.equal(server.net_rx_monthly, 12345);
    const settings = await db.prepare('SELECT value FROM settings WHERE key = ?').bind('site_options').first();
    assert.equal(JSON.parse(settings.value).auto_discovery, 'false');
    const historyCount = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'metrics_history'").first();
    assert.equal(historyCount, null);
  } finally {
    await miniflare.dispose();
  }
});

test('gzip Globalping responses decode before JSON parsing', async () => {
  const stream = new Blob([JSON.stringify({ ok: true })]).stream().pipeThrough(new CompressionStream('gzip'));
  const response = new Response(stream, { headers: { 'content-encoding': 'gzip' } });
  assert.deepEqual(await readGlobalpingJson(response), { ok: true });
});
