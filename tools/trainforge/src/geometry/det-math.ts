/**
 * Power, logarithm and exponential from IEEE basic operations only (an fdlibm port), so the forge writes the same
 * bytes on every platform. V8's own `Math.pow`, `**`, `Math.log`, `Math.tan`, `Math.atan` and `Math.atan2` differ
 * in the last bit between its macOS and Linux builds.
 */

const view = new DataView(new ArrayBuffer(8));

function high(x: number): number {
  view.setFloat64(0, x);
  return view.getInt32(0);
}

function low(x: number): number {
  view.setFloat64(0, x);
  return view.getUint32(4);
}

function withHigh(x: number, hi: number): number {
  view.setFloat64(0, x);
  view.setInt32(0, hi);
  return view.getFloat64(0);
}

const LN2_HI = 0.6931471803691238;
const LN2_LO = 1.9082149292705877e-10;
const TWO54 = 18014398509481984;
const LG1 = 0.6666666666666735;
const LG2 = 0.3999999999940942;
const LG3 = 0.2857142874366239;
const LG4 = 0.22222198432149784;
const LG5 = 0.1818357216161805;
const LG6 = 0.15313837699209373;
const LG7 = 0.14798198605116586;

export function detLog(x: number): number {
  const hx = high(x);
  if (hx < 0x00100000) {
    if (((hx & 0x7fffffff) | low(x)) === 0) return Number.NEGATIVE_INFINITY;
    if (hx < 0) return Number.NaN;
    return logFinite(x * TWO54, -54);
  }
  if (hx >= 0x7ff00000) return x + x;
  return logFinite(x, 0);
}

function logFinite(x: number, scale: number): number {
  const word = high(x);
  const hx = word & 0x000fffff;
  const i = (hx + 0x95f64) & 0x100000;
  const f = withHigh(x, hx | (i ^ 0x3ff00000)) - 1;
  const k = scale + (word >> 20) - 1023 + (i >> 20);
  if ((0x000fffff & (2 + hx)) < 3) return logNearPowerOfTwo(f, k);
  return logSeries(f, k, hx);
}

function logNearPowerOfTwo(f: number, k: number): number {
  if (f === 0) return k === 0 ? 0 : k * LN2_HI + k * LN2_LO;
  const r = f * f * (0.5 - 0.3333333333333333 * f);
  return k === 0 ? f - r : k * LN2_HI - (r - k * LN2_LO - f);
}

function logSeries(f: number, k: number, hx: number): number {
  const s = f / (2 + f);
  const z = s * s;
  const w = z * z;
  const r = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7))) + w * (LG2 + w * (LG4 + w * LG6));
  if (((hx - 0x6147a) | (0x6b851 - hx)) > 0) {
    const hfsq = 0.5 * f * f;
    if (k === 0) return f - (hfsq - s * (hfsq + r));
    return k * LN2_HI - (hfsq - (s * (hfsq + r) + k * LN2_LO) - f);
  }
  if (k === 0) return f - s * (f - r);
  return k * LN2_HI - (s * (f - r) - k * LN2_LO - f);
}

const O_THRESHOLD = 709.782712893384;
const U_THRESHOLD = -745.1332191019411;
const P1 = 0.16666666666666602;
const P2 = -0.0027777777777015593;
const P3 = 0.00006613756321437934;
const P4 = -0.0000016533902205465252;
const P5 = 4.1381367970572385e-8;
const TWOM1000 = 9.332636185032189e-302;

export function detExp(x: number): number {
  const word = high(x);
  const negative = word < 0;
  const hx = word & 0x7fffffff;
  if (hx >= 0x7ff00000) {
    if (((hx & 0xfffff) | low(x)) !== 0) return x + x;
    return negative ? 0 : x;
  }
  if (x > O_THRESHOLD) return Number.POSITIVE_INFINITY;
  if (x < U_THRESHOLD) return 0;
  if (hx < 0x3e300000) return 1 + x;
  if (hx <= 0x3fd62e42) return expSeries(x, 0, 0, 0);
  const k =
    hx < 0x3ff0a2b2 ? (negative ? -1 : 1) : Math.trunc(Math.LOG2E * x + (negative ? -0.5 : 0.5));
  const hi = x - k * LN2_HI;
  const lo = k * LN2_LO;
  return expSeries(hi - lo, hi, lo, k);
}

function expSeries(r: number, hi: number, lo: number, k: number): number {
  const t = r * r;
  const c = r - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
  if (k === 0) return 1 - ((r * c) / (c - 2) - r);
  const y = 1 - (lo - (r * c) / (2 - c) - hi);
  if (k >= -1021) return withHigh(y, high(y) + (k << 20));
  return withHigh(y, high(y) + ((k + 1000) << 20)) * TWOM1000;
}

function powInt(x: number, n: number): number {
  let result = 1;
  let base = x;
  let e = Math.abs(n);
  while (e > 0) {
    if (e & 1) result *= base;
    base *= base;
    e >>>= 1;
  }
  return n < 0 ? 1 / result : result;
}

/** `x ** y` for x >= 0, bit-identical on every platform. */
export function detPow(x: number, y: number): number {
  if (Number.isNaN(x) || Number.isNaN(y)) return Number.NaN;
  if (y === 0 || x === 1) return 1;
  if (x < 0) throw new RangeError(`detPow takes a non-negative base, got ${x}`);
  if (x === 0) return y > 0 ? 0 : Number.POSITIVE_INFINITY;
  if (Number.isInteger(y) && Math.abs(y) <= 64) return powInt(x, y);
  return detExp(y * detLog(x));
}
