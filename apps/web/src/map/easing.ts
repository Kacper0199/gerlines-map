export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const ax = 3 * x1 - 3 * x2 + 1;
  const bx = 3 * x2 - 6 * x1;
  const cx = 3 * x1;
  const ay = 3 * y1 - 3 * y2 + 1;
  const by = 3 * y2 - 6 * y1;
  const cy = 3 * y1;
  const sampleX = (s: number) => ((ax * s + bx) * s + cx) * s;
  const sampleY = (s: number) => ((ay * s + by) * s + cy) * s;
  const slopeX = (s: number) => (3 * ax * s + 2 * bx) * s + cx;
  const solve = (x: number) => {
    let s = x;
    for (let step = 0; step < 8; step += 1) {
      const error = sampleX(s) - x;
      const slope = slopeX(s);
      if (Math.abs(error) < 1e-6 || Math.abs(slope) < 1e-6) {
        break;
      }
      s -= error / slope;
    }
    let low = 0;
    let high = 1;
    for (let step = 0; step < 30 && Math.abs(sampleX(s) - x) >= 1e-6; step += 1) {
      s = (low + high) / 2;
      if (sampleX(s) < x) {
        low = s;
      } else {
        high = s;
      }
    }
    return s;
  };
  return (t: number) => {
    if (t <= 0) {
      return 0;
    }
    if (t >= 1) {
      return 1;
    }
    return sampleY(solve(t));
  };
}

export const easeOutDesign = cubicBezier(0.2, 0.7, 0.2, 1);
