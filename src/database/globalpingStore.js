const CREATE_POINTS_SQL = `
  CREATE TABLE IF NOT EXISTS globalping_outbound_points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id TEXT NOT NULL,
    measurement_id TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    carrier TEXT NOT NULL,
    asn INTEGER,
    city TEXT DEFAULT '',
    network TEXT DEFAULT '',
    tags TEXT DEFAULT '[]',
    avg REAL,
    min REAL,
    max REAL,
    loss REAL,
    rcv INTEGER,
    pkt_drop INTEGER,
    total INTEGER,
    status TEXT DEFAULT '',
    probe_country TEXT
  )
`;

const CREATE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_globalping_outbound_server_time
  ON globalping_outbound_points (server_id, created_at)
`;

const CREATE_STATE_SQL = `
  CREATE TABLE IF NOT EXISTS globalping_outbound_state (
    id INTEGER PRIMARY KEY,
    bucket INTEGER,
    pending TEXT NOT NULL DEFAULT '[]'
  )
`;

const INSERT_SQL = `
  INSERT INTO globalping_outbound_points (
    server_id, measurement_id, created_at, carrier, asn, city, network, tags,
    avg, min, max, loss, rcv, pkt_drop, total, status, probe_country
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const TIMEOUT_STATUSES = new Set(['timeout', 'failed', 'gap', 'no_probes']);

function nullIfBlank(value) {
  return value === undefined ? null : value;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseTags(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function toPublicOutboundPoint(row) {
  const status = String(row?.status || '');
  const timedOut = TIMEOUT_STATUSES.has(status);
  return {
    timestamp: Number(row.created_at),
    measurement_id: row.measurement_id || '',
    carrier: row.carrier,
    asn: row.asn === null || row.asn === undefined ? null : Number(row.asn),
    city: row.city || '',
    network: row.network || '',
    tags: parseTags(row.tags),
    avg: timedOut ? null : numberOrNull(row.avg),
    min: timedOut ? null : numberOrNull(row.min),
    max: timedOut ? null : numberOrNull(row.max),
    loss: timedOut ? null : numberOrNull(row.loss),
    rcv: timedOut ? null : numberOrNull(row.rcv),
    drop: timedOut ? null : numberOrNull(row.pkt_drop),
    total: timedOut ? null : numberOrNull(row.total),
    status,
    probe_country: row.probe_country || null
  };
}

export async function ensureOutboundTables(db) {
  await db.prepare(CREATE_POINTS_SQL).run();
  await db.prepare(CREATE_INDEX_SQL).run();
  await db.prepare(CREATE_STATE_SQL).run();
}

export async function readOutboundState(db) {
  const row = await db.prepare(
    'SELECT bucket, pending FROM globalping_outbound_state WHERE id = 1'
  ).first();
  if (!row) return { bucket: null, pending: [] };
  let pending = [];
  try {
    pending = JSON.parse(row.pending || '[]');
  } catch {
    pending = [];
  }
  if (!Array.isArray(pending)) pending = [];
  return {
    bucket: row.bucket === null || row.bucket === undefined ? null : Number(row.bucket),
    pending
  };
}

export async function writeOutboundState(db, bucket, pending) {
  await db.prepare(`
    INSERT INTO globalping_outbound_state (id, bucket, pending)
    VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET bucket = excluded.bucket, pending = excluded.pending
  `).bind(bucket, JSON.stringify(pending || [])).run();
}

function insertStatement(db, serverId, point) {
  return db.prepare(INSERT_SQL).bind(
    serverId,
    point.measurement_id || '',
    point.created_at,
    point.carrier,
    nullIfBlank(point.asn),
    point.city || '',
    point.network || '',
    JSON.stringify(point.tags || []),
    nullIfBlank(point.avg),
    nullIfBlank(point.min),
    nullIfBlank(point.max),
    nullIfBlank(point.loss),
    nullIfBlank(point.rcv),
    nullIfBlank(point.drop),
    nullIfBlank(point.total),
    point.status || '',
    nullIfBlank(point.probe_country)
  );
}

export async function saveOutboundPoints(db, serverId, points) {
  await ensureOutboundTables(db);
  const rows = (Array.isArray(points) ? points : []).filter(point => point && point.carrier);
  if (rows.length === 0) return 0;

  const measurementIds = [...new Set(rows.map(point => point.measurement_id).filter(Boolean))];
  const existing = new Set();
  if (measurementIds.length > 0) {
    const placeholders = measurementIds.map(() => '?').join(', ');
    const found = await db.prepare(
      `SELECT measurement_id, carrier FROM globalping_outbound_points
       WHERE server_id = ? AND measurement_id IN (${placeholders})`
    ).bind(serverId, ...measurementIds).all();
    for (const row of found.results || []) {
      existing.add(`${row.measurement_id}:${row.carrier}`);
    }
  }

  const inserts = [];
  for (const point of rows) {
    const key = point.measurement_id ? `${point.measurement_id}:${point.carrier}` : '';
    if (key && existing.has(key)) continue;
    if (key) existing.add(key);
    inserts.push(point);
  }
  if (inserts.length === 0) return 0;

  await db.batch(inserts.map(point => insertStatement(db, serverId, point)));
  return inserts.length;
}

export async function pruneOutboundPoints(db, serverId, cutoff) {
  await db.prepare(
    'DELETE FROM globalping_outbound_points WHERE server_id = ? AND created_at < ?'
  ).bind(serverId, cutoff).run();
}

async function selectOutboundPoints(db, serverId, sinceMs) {
  const result = await db.prepare(`
    SELECT measurement_id, created_at, carrier, asn, city, network, tags,
           avg, min, max, loss, rcv, pkt_drop, total, status, probe_country
    FROM globalping_outbound_points
    WHERE server_id = ? AND created_at >= ?
    ORDER BY created_at ASC
    LIMIT 2000
  `).bind(serverId, sinceMs).all();
  return (result.results || []).map(toPublicOutboundPoint);
}

export async function getOutboundHistory(db, serverId, sinceMs) {
  await ensureOutboundTables(db);
  return selectOutboundPoints(db, serverId, sinceMs);
}

export async function readOutboundHistory(db, serverId, sinceMs) {
  return selectOutboundPoints(db, serverId, sinceMs);
}
