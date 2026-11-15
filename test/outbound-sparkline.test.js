import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OUTBOUND_SLOT_MS,
  buildOutboundHistorySlots,
  outboundSlotCount
} from '../src/frontend/utils/outboundLatency.js';

const WINDOW_MS = 2 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 12, 8, 0, 0);

function point(timestamp, carrier, avg, loss = 0, status = 'finished') {
  return { timestamp, carrier, avg, loss, status, probe_country: 'CN' };
}

test('two real samples stay on a 5-minute grid and do not fill every slot', () => {
  assert.equal(outboundSlotCount(WINDOW_MS), 24);
  const grid = buildOutboundHistorySlots([
    point(NOW - 10 * 60 * 1000, 'ct', 42, 0),
    point(NOW - 5 * 60 * 1000, 'ct', 55, 1)
  ], 'ct', { now: NOW, windowMs: WINDOW_MS });

  assert.equal(grid.slotCount, 24);
  assert.equal(grid.slotMs, OUTBOUND_SLOT_MS);
  const colored = grid.slots.filter(slot => slot.sample);
  assert.equal(colored.length, 2);
  assert.deepEqual(colored.map(slot => slot.sample.y), [42, 55]);
  assert.equal(colored[1].sample.timestamp - colored[0].sample.timestamp, OUTBOUND_SLOT_MS);
  assert.equal(grid.slots.filter(slot => slot.sample === null).length, 22);
  assert.equal(grid.slots.some(slot => slot.sample && slot.sample.y === 0), false);
});

test('zero samples leave the carrier hidden', () => {
  assert.equal(buildOutboundHistorySlots([], 'ct', { now: NOW, windowMs: WINDOW_MS }), null);
  assert.equal(buildOutboundHistorySlots([
    point(NOW - 5 * 60 * 1000, 'cu', 30, 0)
  ], 'ct', { now: NOW, windowMs: WINDOW_MS }), null);
});

test('a long history keeps only in-window samples and does not duplicate them', () => {
  const points = [];
  for (let index = 0; index < 48; index += 1) {
    points.push(point(NOW - (47 - index) * OUTBOUND_SLOT_MS, 'cm', 80 + (index % 5), index % 3));
  }
  const grid = buildOutboundHistorySlots(points, 'cm', { now: NOW, windowMs: WINDOW_MS });
  assert.equal(grid.slotCount, 24);
  const colored = grid.slots.filter(slot => slot.sample);
  assert.equal(colored.length, 24);
  const stamps = colored.map(slot => slot.sample.timestamp);
  assert.equal(new Set(stamps).size, 24);
  assert.equal(stamps.every(stamp => points.some(item => item.timestamp === stamp)), true);
  assert.equal(stamps.every(stamp => stamp >= NOW - WINDOW_MS && stamp <= NOW), true);
  assert.equal(stamps.includes(NOW - 47 * OUTBOUND_SLOT_MS), false);
  assert.equal(stamps[stamps.length - 1], NOW);
});

test('two samples inside one slot keep the later real point instead of blending them', () => {
  const grid = buildOutboundHistorySlots([
    point(NOW - 5 * 60 * 1000, 'cu', 20, 0),
    point(NOW - 5 * 60 * 1000 + 1000, 'cu', 70, 4)
  ], 'cu', { now: NOW, windowMs: WINDOW_MS });
  const colored = grid.slots.filter(slot => slot.sample);
  assert.equal(colored.length, 1);
  assert.equal(colored[0].sample.y, 70);
  assert.equal(colored[0].sample.loss, 4);
});

test('a timeout sample is present but not turned into a zero latency', () => {
  const grid = buildOutboundHistorySlots([
    point(NOW - OUTBOUND_SLOT_MS, 'ct', null, null, 'timeout')
  ], 'ct', { now: NOW, windowMs: WINDOW_MS });
  const colored = grid.slots.filter(slot => slot.sample);
  assert.equal(colored.length, 1);
  assert.equal(colored[0].sample.y, null);
  assert.equal(colored[0].sample.loss, null);
});
