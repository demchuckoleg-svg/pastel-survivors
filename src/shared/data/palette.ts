/**
 * Soft pastel color palette tokens for Pastel Survivors.
 * Uses dark plum/slate (#3a3245) for crisp 1px pixel-art outlines and UI text.
 * Pure data module (zero DOM/Canvas dependencies) shared across client and simulation.
 */
export const PALETTE = {
  // Ground & environment
  groundBase: '#d8e8d4',
  groundAlt: '#cde0c8',
  groundDark: '#b8d1b2',
  groundLight: '#e4f0e1',

  // Core pastels
  lavender: '#c5b4e3',
  lavenderDark: '#9d88c4',
  lavenderLight: '#e2d9f3',

  peach: '#f7c5a8',
  peachDark: '#e39e7a',
  peachLight: '#fde0ce',

  babyBlue: '#a8d8f0',
  babyBlueDark: '#7bb5d6',
  babyBlueLight: '#d4eefc',

  coral: '#f29ca3',
  coralDark: '#d9717a',
  coralLight: '#fbc8cc',

  cream: '#fdf6e3',
  creamDark: '#ebe0c5',

  butter: '#f7e6a8',
  butterDark: '#e0c76e',
  butterLight: '#fcf4d2',

  mint: '#a8e6cf',
  mintDark: '#76c4a8',
  mintLight: '#d2f5e7',

  rose: '#f4b6d2',
  roseDark: '#d689ad',

  periwinkle: '#b4c5f0',
  periwinkleDark: '#859bd6',

  sage: '#9ec49b',
  sageDark: '#769e73',

  slate: '#7a728a',
  slateLight: '#a69eb5',
  slateDark: '#575066',

  // Outlines, highlights & shadows
  outline: '#3a3245',
  white: '#ffffff',
  shadow: 'rgba(58, 50, 69, 0.22)',
} as const;

export type PaletteKey = keyof typeof PALETTE;
