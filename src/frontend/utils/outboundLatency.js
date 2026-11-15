export const OUTBOUND_SERIES = Object.freeze(['ct', 'cu', 'cm']);
export const OUTBOUND_SLOT_MS = 5 * 60 * 1000;

const TIMEOUT_STATUSES = new Set(['timeout', 'failed', 'gap', 'no_probes']);

export function outboundTimestamp(point) {
  const timestamp = Number(point?.timestamp ?? point?.created_at);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 0;
  return timestamp < 10000000000 ? timestamp * 1000 : timestamp;
}

export function isDisabledOutboundPoint(point) {
  return point?.status === 'disabled' || point?.disabled === true || point?.avg === false;
}

export function outboundPingValue(point) {
  if (!point || isDisabledOutboundPoint(point) || TIMEOUT_STATUSES.has(point.status)) return null;
  if (point.avg === null || point.avg === undefined || point.avg === '') return null;
  const number = Number(point.avg);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.round(number);
}

export function outboundLossValue(point) {
  if (!point || isDisabledOutboundPoint(point) || TIMEOUT_STATUSES.has(point.status)) return null;
  if (point.loss === null || point.loss === undefined || point.loss === '') return null;
  const number = Number(point.loss);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(100, Math.round(number)));
}

export function buildOutboundChartSeries(points, carrier) {
  const rows = (Array.isArray(points) ? points : [])
    .filter(point => point && point.carrier === carrier)
    .map(point => ({ ...point, timestamp: outboundTimestamp(point) }))
    .filter(point => point.timestamp > 0)
    .sort((a, b) => a.timestamp - b.timestamp);

  if (rows.length === 0 || isDisabledOutboundPoint(rows[rows.length - 1])) {
    return { hidden: true, rows: [] };
  }

  return {
    hidden: false,
    rows: rows.map(row => ({
      timestamp: row.timestamp,
      y: outboundPingValue(row),
      loss: outboundLossValue(row)
    }))
  };
}

export function outboundSlotCount(windowMs, slotMs = OUTBOUND_SLOT_MS) {
  const span = Number(windowMs);
  const slot = Number(slotMs);
  if (!Number.isFinite(span) || span <= 0 || !Number.isFinite(slot) || slot <= 0) return 0;
  return Math.max(1, Math.round(span / slot));
}

// Place real 5-minute samples into a fixed slot grid. Empty slots stay empty;
// nothing is copied, averaged, or moved onto a 1-minute tick.
export function buildOutboundHistorySlots(points, carrier, { now = Date.now(), windowMs, slotMs = OUTBOUND_SLOT_MS } = {}) {
  const series = buildOutboundChartSeries(points, carrier);
  if (series.hidden) return null;

  const slotCount = outboundSlotCount(windowMs, slotMs);
  if (slotCount === 0) return null;
  const end = Number(now);
  const start = end - slotCount * slotMs;
  const slots = Array.from({ length: slotCount }, (_, index) => ({
    slotStart: start + index * slotMs,
    sample: null
  }));

  for (const row of series.rows) {
    if (row.timestamp < start || row.timestamp > end) continue;
    const index = Math.min(slotCount - 1, Math.floor((row.timestamp - start) / slotMs));
    const current = slots[index].sample;
    if (!current || row.timestamp >= current.timestamp) slots[index].sample = row;
  }

  return { slots, slotMs, slotCount, start };
}

export function attachOutboundPoints(server, points) {
  if (!server || !Array.isArray(points) || points.length === 0) return server;
  server.outbound = { points };
  return server;
}
