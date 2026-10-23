// Deterministic inline SVG placeholders (option images: "svg"). No network, no fonts beyond
// the generic `sans-serif`, no clock. Every number comes from the value's own stream or from
// persona slots, so an avatar's initials agree with the entity's name.

const PALETTE = [
  "#1f6feb", "#8250df", "#bf3989", "#cf222e", "#bc4c00", "#9a6700",
  "#1a7f37", "#0f766e", "#0969da", "#6e7781", "#7d4e57", "#3b6ea5",
];

const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&apos;").replace(/"/g, "&quot;");

/** A `data:image/svg+xml` URI. Markup uses single quotes only, so no quote needs escaping in the URI. */
export function svgDataUri(svg) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg).replace(/%3D/g, "=").replace(/%3A/g, ":").replace(/%2F/g, "/")}`;
}

const initialOf = (name) => {
  for (const ch of name) {
    if (/\p{L}/u.test(ch)) return ch.toUpperCase();
  }
  return "?";
};

/** Initials on a coloured square; the colour is a persona slot so it is stable per entity. */
export function avatarSvg(first, last, colorIndex, size = 128) {
  const initials = initialOf(first) + initialOf(last);
  const half = size / 2;
  const fill = PALETTE[colorIndex % PALETTE.length];
  return (
    `<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}' viewBox='0 0 ${size} ${size}' role='img' aria-label='${esc(initials)}'>` +
    `<rect width='${size}' height='${size}' fill='${fill}'/>` +
    `<text x='${half}' y='${half}' dy='.35em' text-anchor='middle' font-family='sans-serif' font-size='${Math.round(size * 0.42)}' fill='#fff'>${esc(initials)}</text></svg>`
  );
}

/** A background plus three to five translucent shapes, all from the value's stream. */
export function geometricSvg(s, width = 320, height = 240) {
  const bg = PALETTE[s.int(0, PALETTE.length - 1)];
  const n = s.int(3, 5);
  let body = `<rect width='${width}' height='${height}' fill='${bg}'/>`;
  for (let i = 0; i < n; i++) {
    const fill = PALETTE[s.int(0, PALETTE.length - 1)];
    const opacity = (s.int(35, 80) / 100).toFixed(2);
    const kind = s.int(0, 2);
    const cx = s.int(0, width);
    const cy = s.int(0, height);
    const r = s.int(Math.round(Math.min(width, height) / 8), Math.round(Math.min(width, height) / 2.5));
    if (kind === 0) body += `<circle cx='${cx}' cy='${cy}' r='${r}' fill='${fill}' fill-opacity='${opacity}'/>`;
    else if (kind === 1) body += `<rect x='${cx - r}' y='${cy - r}' width='${2 * r}' height='${Math.round(r * 1.4)}' fill='${fill}' fill-opacity='${opacity}'/>`;
    else body += `<polygon points='${cx},${cy - r} ${cx + r},${cy + r} ${cx - r},${cy + r}' fill='${fill}' fill-opacity='${opacity}'/>`;
  }
  return `<svg xmlns='http://www.w3.org/2000/svg' width='${width}' height='${height}' viewBox='0 0 ${width} ${height}' role='img' aria-label='placeholder'>${body}</svg>`;
}

export { PALETTE };
