// Joint-angle math and road-fit target ranges. Pure functions, no DOM.
// Angles are interior angles in degrees: a straight leg reads 180.

// MediaPipe pose landmark indices per body side.
export const SIDES = {
  left: { shoulder: 11, elbow: 13, wrist: 15, hip: 23, knee: 25, ankle: 27, heel: 29, foot: 31 },
  right: { shoulder: 12, elbow: 14, wrist: 16, hip: 24, knee: 26, ankle: 28, heel: 30, foot: 32 },
};

// Skeleton segments to draw, as pairs of joint names.
export const BONES = [
  ['shoulder', 'elbow'], ['elbow', 'wrist'], ['shoulder', 'hip'],
  ['hip', 'knee'], ['knee', 'ankle'], ['ankle', 'heel'], ['heel', 'foot'], ['ankle', 'foot'],
];

// Interior angle at b formed by a-b-c.
export function angle(a, b, c) {
  const v1 = [a.x - b.x, a.y - b.y];
  const v2 = [c.x - b.x, c.y - b.y];
  const n = Math.hypot(...v1) * Math.hypot(...v2);
  if (!n) return NaN;
  const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / n;
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

// Angle of the hip→shoulder line above horizontal, 0 = flat back, 90 = upright.
export function torsoAngle(hip, shoulder) {
  return (Math.atan2(Math.abs(shoulder.y - hip.y), Math.abs(shoulder.x - hip.x)) * 180) / Math.PI;
}

// Side facing the camera = the one MediaPipe sees more confidently.
export function pickSide(landmarks) {
  const vis = (s) => Object.values(SIDES[s]).reduce((t, i) => t + (landmarks[i]?.visibility ?? 0), 0);
  return vis('left') >= vis('right') ? 'left' : 'right';
}

// Joint positions in pixels for one side.
export function joints(landmarks, side, w, h) {
  const out = {};
  for (const [name, i] of Object.entries(SIDES[side])) out[name] = { x: landmarks[i].x * w, y: landmarks[i].y * h };
  return out;
}

export function computeAngles(j) {
  return {
    knee: angle(j.hip, j.knee, j.ankle),
    hip: angle(j.shoulder, j.hip, j.knee),
    torso: torsoAngle(j.hip, j.shoulder),
    elbow: angle(j.shoulder, j.elbow, j.wrist),
    shoulder: angle(j.hip, j.shoulder, j.elbow),
    ankle: angle(j.knee, j.ankle, j.foot),
  };
}

// Min/max/mean of each angle over a recording window.
export class Tracker {
  constructor() { this.s = {}; this.frames = 0; }
  add(angles) {
    this.frames++;
    for (const [k, v] of Object.entries(angles)) {
      if (!Number.isFinite(v)) continue;
      const s = (this.s[k] ??= { min: Infinity, max: -Infinity, sum: 0, n: 0 });
      s.min = Math.min(s.min, v); s.max = Math.max(s.max, v); s.sum += v; s.n++;
    }
  }
  stats() {
    const out = {};
    for (const [k, s] of Object.entries(this.s)) {
      out[k] = { min: round(s.min), max: round(s.max), mean: round(s.sum / s.n) };
    }
    return out;
  }
}

const round = (v) => Math.round(v * 10) / 10;

// Road-bike starting ranges (common fit-literature values, on the hoods). Edit to taste.
// `stat` says which recorded statistic is judged; live values use `live`.
export const TARGETS = {
  road: {
    knee_max: { angle: 'knee', stat: 'max', range: [140, 150], label: 'Knee extension (bottom)' },
    knee_min: { angle: 'knee', stat: 'min', range: [65, 75], label: 'Knee flexion (top)' },
    hip_min: { angle: 'hip', stat: 'min', range: [45, 60], label: 'Hip angle (closed)' },
    torso: { angle: 'torso', stat: 'mean', range: [35, 50], label: 'Torso to horizontal', live: true },
    elbow: { angle: 'elbow', stat: 'mean', range: [150, 165], label: 'Elbow', live: true },
    shoulder: { angle: 'shoulder', stat: 'mean', range: [80, 95], label: 'Shoulder', live: true },
  },
};

// 'good' inside range, 'near' within `slack` degrees, else 'off'.
export function status(value, [lo, hi], slack = 5) {
  if (!Number.isFinite(value)) return 'none';
  if (value >= lo && value <= hi) return 'good';
  if (value >= lo - slack && value <= hi + slack) return 'near';
  return 'off';
}
