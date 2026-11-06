// The sign-in page's terrazzo floor (UI_RULES §18). Stone chips are drawn once into a small seamless tile
// for each surface (the floor, and the two inlaid brackets) and handed to CSS as background images. A chip's
// colour is a theme token read at runtime, so a re-skin recolours the floor and no colour literal ships
// (UI_RULES §121). Seeded, so the floor is the same on every visit.

// The tile's CSS size (index.css sets background-size to the same 22.5rem); drawn at twice that for sharp screens.
const TILE = 360;
const SCALE = 2;

// [token, weight] per surface: the floor in the greys with a scatter of the brand; each inlay in lighter and
// darker chips of its own colour, with white and the other brand colour for contrast.
const PALETTES = {
  ground: [
    ['--color-neutral-300', 30], ['--color-neutral-400', 14], ['--card-bg', 16], ['--primary', 16],
    ['--color-brand-primary-400', 10], ['--color-brand-secondary-500', 10], ['--color-brand-secondary-700', 4],
  ],
  primary: [
    ['--card-bg', 30], ['--color-brand-primary-400', 34], ['--color-brand-secondary-500', 22], ['--color-brand-primary-700', 14],
  ],
  accent: [
    ['--card-bg', 34], ['--primary', 26], ['--color-brand-secondary-700', 24], ['--color-brand-secondary-100', 16],
  ],
};
const COUNTS = { ground: 190, primary: 88, accent: 88 };
const SEEDS = { ground: 4, primary: 9, accent: 17 };

// mulberry32, a small seeded generator
function seeded(seed) {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rand, palette) {
  const total = palette.reduce((sum, [, weight]) => sum + weight, 0);
  let x = rand() * total;
  for (const [token, weight] of palette) {
    x -= weight;
    if (x <= 0) return token;
  }
  return palette[0][0];
}

function drawTile(surface, colourOf) {
  const canvas = document.createElement('canvas');
  canvas.width = TILE * SCALE;
  canvas.height = TILE * SCALE;
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.scale(SCALE, SCALE);
  const rand = seeded(SEEDS[surface]);
  for (let i = 0; i < COUNTS[surface]; i++) {
    const cx = rand() * TILE;
    const cy = rand() * TILE;
    const radius = 1.2 + rand() ** 2.2 * 8;
    const sides = 4 + Math.floor(rand() * 3);
    const corners = [];
    for (let j = 0; j < sides; j++) {
      const angle = (j / sides) * Math.PI * 2 + rand() * 0.8;
      const reach = radius * (0.6 + rand() * 0.5);
      corners.push([Math.cos(angle) * reach, Math.sin(angle) * reach]);
    }
    g.fillStyle = colourOf(pick(rand, PALETTES[surface]));
    // drawn at every wrap-around offset, so a chip cut by one edge carries on from the opposite one
    for (const ox of [-TILE, 0, TILE]) {
      for (const oy of [-TILE, 0, TILE]) {
        g.beginPath();
        corners.forEach(([x, y], k) => {
          if (k) g.lineTo(cx + ox + x, cy + oy + y);
          else g.moveTo(cx + ox + x, cy + oy + y);
        });
        g.closePath();
        g.fill();
      }
    }
  }
  return canvas.toDataURL('image/png');
}

let style;

// The three tiles as the custom properties the sign-in page reads, drawn once per load; null where there is no
// canvas, and the page then shows the flat colours under them.
export function terrazzoStyle() {
  if (style !== undefined) return style;
  style = null;
  if (typeof document === 'undefined') return style;
  const css = getComputedStyle(document.documentElement);
  const colourOf = (token) => css.getPropertyValue(token).trim();
  const tiles = {};
  for (const surface of Object.keys(PALETTES)) {
    const url = drawTile(surface, colourOf);
    if (!url) return style;
    tiles[surface] = url;
  }
  style = {
    '--login-terrazzo-ground': `url("${tiles.ground}")`,
    '--login-terrazzo-primary': `url("${tiles.primary}")`,
    '--login-terrazzo-accent': `url("${tiles.accent}")`,
  };
  return style;
}
