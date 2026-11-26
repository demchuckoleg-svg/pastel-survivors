import { PALETTE, type PaletteKey } from '@shared/data/palette';

export { PALETTE, type PaletteKey };

/**
 * Single-character color legend used when baking 16x16 and 32x32 pixel matrices.
 * '.' and ' ' represent transparent pixels.
 */
export const PIXEL_CHARS: Record<string, string | null> = {
  '.': null,
  ' ': null,
  k: PALETTE.outline,
  w: PALETTE.white,
  c: PALETTE.cream,
  C: PALETTE.creamDark,
  l: PALETTE.lavender,
  L: PALETTE.lavenderDark,
  v: PALETTE.lavenderLight,
  p: PALETTE.peach,
  P: PALETTE.peachDark,
  h: PALETTE.peachLight,
  b: PALETTE.babyBlue,
  B: PALETTE.babyBlueDark,
  i: PALETTE.babyBlueLight,
  r: PALETTE.coral,
  R: PALETTE.coralDark,
  x: PALETTE.coralLight,
  y: PALETTE.butter,
  Y: PALETTE.butterDark,
  z: PALETTE.butterLight,
  m: PALETTE.mint,
  M: PALETTE.mintDark,
  n: PALETTE.mintLight,
  o: PALETTE.rose,
  O: PALETTE.roseDark,
  u: PALETTE.periwinkle,
  U: PALETTE.periwinkleDark,
  g: PALETTE.sage,
  G: PALETTE.sageDark,
  s: PALETTE.slate,
  S: PALETTE.slateLight,
  t: PALETTE.slateDark,
  d: PALETTE.groundDark,
  e: PALETTE.groundAlt,
  a: PALETTE.groundBase,
  f: PALETTE.groundLight,
};
