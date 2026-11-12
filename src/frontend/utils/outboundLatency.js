export const OUTBOUND_SERIES = Object.freeze(['ct', 'cu', 'cm']);

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

export function attachOutboundPoints(server, points) {
  if (!server || !Array.isArray(points) || points.length === 0) return server;
  server.outbound = { points };
  return server;
}
