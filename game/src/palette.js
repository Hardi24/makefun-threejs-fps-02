// The look plan, in one place. Six base values and one accent hue, plus the two team
// colours the HUD, the bots and the site markers share. The lighting makes every shade the
// game needs, so no other colour appears in the code. The same names are the CSS custom
// properties in index.html.
export const PALETTE = {
  canvas: '#14161a',
  surface: '#1e2228',
  hairline: '#2c323a',
  ink: '#e9e6df',
  muted: '#98a0a8',
  accent: '#f0a830',
  vanguard: '#3fc1a8',
  raider: '#e4572e',
  siteA: '#3fc1a8',
  siteB: '#f0a830',
};

export function shade(name) {
  return PALETTE[name];
}
