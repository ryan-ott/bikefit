import { test } from 'node:test';
import assert from 'node:assert/strict';
import { angle, torsoAngle, pickSide, Tracker, status } from './static/angles.js';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

test('angle', () => {
  near(angle({ x: 0, y: 1 }, { x: 0, y: 0 }, { x: 1, y: 0 }), 90);
  near(angle({ x: -1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }), 180);
  near(angle({ x: 1, y: 1 }, { x: 0, y: 0 }, { x: 1, y: 0 }), 45);
  assert.ok(Number.isNaN(angle({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 })));
});

test('torsoAngle ignores facing direction and image y-down', () => {
  near(torsoAngle({ x: 0, y: 10 }, { x: 10, y: 0 }), 45);
  near(torsoAngle({ x: 10, y: 10 }, { x: 0, y: 0 }), 45);
  near(torsoAngle({ x: 0, y: 10 }, { x: 0, y: 0 }), 90);
});

test('pickSide picks the more visible side', () => {
  const lm = Array.from({ length: 33 }, () => ({ visibility: 0.1 }));
  [12, 14, 16, 24, 26, 28, 30, 32].forEach((i) => (lm[i].visibility = 0.9));
  assert.equal(pickSide(lm), 'right');
});

test('Tracker min/max/mean, skips NaN', () => {
  const t = new Tracker();
  [140, 70, 110, NaN].forEach((knee) => t.add({ knee }));
  assert.deepEqual(t.stats().knee, { min: 70, max: 140, mean: 106.7 });
});

test('status', () => {
  assert.equal(status(145, [140, 150]), 'good');
  assert.equal(status(137, [140, 150]), 'near');
  assert.equal(status(130, [140, 150]), 'off');
  assert.equal(status(NaN, [140, 150]), 'none');
});
