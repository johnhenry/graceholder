// Deterministic elementary functions built only from + - * / and exact scaling by 2.
// IEEE-754 basic operations are correctly rounded on every engine, whereas Math.exp, Math.log,
// Math.pow, Math.sin and Math.cos may differ in the last bit between engines. Output that
// depends on these functions must be byte-identical everywhere (docs/design.md section 11), so
// distribution sampling uses these instead. Accuracy is far better than the 2-4 decimals that
// are ever emitted; determinism, not libm accuracy, is the point.

const LN2 = 0.6931471805599453;
const TWO_PI = 6.283185307179586;

/** Natural logarithm of x > 0. */
export function ln(x) {
  if (!(x > 0)) throw new RangeError(`ln(${x}): need x > 0`);
  let e = 0;
  while (x >= 2) { x /= 2; e++; }
  while (x < 1) { x *= 2; e--; }
  if (x > 1.4142135623730951) { x /= 2; e++; }
  const z = (x - 1) / (x + 1);
  const z2 = z * z;
  let term = z;
  let sum = 0;
  for (let k = 1; k <= 41; k += 2) {
    sum += term / k;
    term *= z2;
  }
  return 2 * sum + e * LN2;
}

/** e^x for |x| below about 700. */
export function exp(x) {
  const k = Math.round(x / LN2);
  const r = x - k * LN2;
  let term = 1;
  let sum = 1;
  for (let n = 1; n <= 24; n++) {
    term = (term * r) / n;
    sum += term;
  }
  const base = k < 0 ? 0.5 : 2;
  let p = 1;
  for (let i = Math.abs(k); i > 0; i--) p *= base;
  return sum * p;
}

/** x^y for x > 0. */
export const pow = (x, y) => exp(y * ln(x));

const reduce = (x) => x - Math.round(x / TWO_PI) * TWO_PI;

export function sin(x) {
  const r = reduce(x);
  const r2 = r * r;
  let term = r;
  let sum = r;
  for (let n = 1; n <= 15; n++) {
    term = (-term * r2) / ((2 * n) * (2 * n + 1));
    sum += term;
  }
  return sum;
}

export function cos(x) {
  const r = reduce(x);
  const r2 = r * r;
  let term = 1;
  let sum = 1;
  for (let n = 1; n <= 15; n++) {
    term = (-term * r2) / ((2 * n - 1) * (2 * n));
    sum += term;
  }
  return sum;
}

export { TWO_PI };
