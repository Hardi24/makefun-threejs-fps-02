// The look plan, in one place. The palette is small on purpose: six base values and
// one accent hue, plus the two team colours that the HUD, the bots and the site markers
// share. Lighting does the rest, so no other colour appears in the code. The same names
// are the CSS custom properties in index.html — change one here and the whole game, HUD
// included, follows. Gold is the accent's brighter sibling, for kill-streak toasts and
// headshot callouts; ghost is the dim grey of last-seen markers on the minimap.
export const PALETTE = {
  canvas: '#14161a',
  surface: '#1e2228',
  hairline: '#2c323a',
  ink: '#e9e6df',
  muted: '#98a0a8',
  accent: '#f0a830',
  gold: '#ffd34d',
  ghost: '#7d8590',
  vanguard: '#3fc1a8',
  raider: '#e4572e',
  siteA: '#3fc1a8',
  siteB: '#f0a830',
};

// A named colour by its key. Every module reads the palette through this helper,
// never a literal, so the look plan stays in one place.
export function shade(name) {
  return PALETTE[name];
}
