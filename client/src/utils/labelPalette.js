/**
 * Canonical 9-color label palette (skill §10.4).
 *
 * Use these tokens for label pills, group colors, letter-avatar backgrounds,
 * and anywhere a categorical color is needed. Each token includes the bg,
 * text-on-bg, soft/outlined background tint, and border for outlined variants.
 *
 * Adding a new color? Mirror the shape below and append to PALETTE_ORDER.
 */

export const LABEL_PALETTE = {
  red: {
    bg: '#df2f4a',
    text: '#ffffff',
    soft: '#fae0e3',
    softText: '#a31329',
    border: '#df2f4a',
  },
  orange: {
    bg: '#fdab3d',
    text: '#ffffff',
    soft: '#feeccc',
    softText: '#a85e00',
    border: '#fdab3d',
  },
  yellow: {
    bg: '#ffcb00',
    text: '#3d2a00',
    soft: '#fff3b8',
    softText: '#7a5b00',
    border: '#ffcb00',
  },
  green: {
    bg: '#00c875',
    text: '#ffffff',
    soft: '#bbe9d3',
    softText: '#006a3d',
    border: '#00c875',
  },
  teal: {
    bg: '#4eccc6',
    text: '#ffffff',
    soft: '#cdf0ee',
    softText: '#0a6661',
    border: '#4eccc6',
  },
  blue: {
    bg: '#579bfc',
    text: '#ffffff',
    soft: '#d5e6ff',
    softText: '#1b4d99',
    border: '#579bfc',
  },
  purple: {
    bg: '#9d50dd',
    text: '#ffffff',
    soft: '#e8d6f5',
    softText: '#5a2890',
    border: '#9d50dd',
  },
  pink: {
    bg: '#ff158a',
    text: '#ffffff',
    soft: '#ffd2e6',
    softText: '#a8005b',
    border: '#ff158a',
  },
  gray: {
    bg: '#c4c4c4',
    text: '#3d3d3d',
    soft: '#ebebeb',
    softText: '#5a5a5a',
    border: '#c4c4c4',
  },
};

export const PALETTE_ORDER = [
  'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'gray',
];

/**
 * Resolve any color input (palette token, hex, rgb()) to a palette entry.
 * Falls back to gray when input is unknown.
 */
export function resolvePaletteColor(input) {
  if (!input) return LABEL_PALETTE.gray;
  if (LABEL_PALETTE[input]) return LABEL_PALETTE[input];

  // Hex input — find the closest palette token by bg match, else synthesize.
  if (typeof input === 'string' && input.startsWith('#')) {
    const lower = input.toLowerCase();
    for (const token of PALETTE_ORDER) {
      if (LABEL_PALETTE[token].bg.toLowerCase() === lower) return LABEL_PALETTE[token];
    }
    return { ...LABEL_PALETTE.gray, bg: input, border: input };
  }

  return LABEL_PALETTE.gray;
}

/**
 * Deterministic palette token from a name (used for LetterAvatar coloring
 * when no explicit color is given). Same name → same color across renders.
 */
export function hashToPaletteToken(name) {
  if (!name) return 'gray';
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = name.charCodeAt(i) + ((h << 5) - h);
  }
  // Exclude gray from hash output (gray is reserved for "no name") — pick
  // among the 8 vibrant colors only.
  const vibrant = PALETTE_ORDER.slice(0, 8);
  return vibrant[Math.abs(h) % vibrant.length];
}

/**
 * Pick a contrasting text color for an arbitrary hex background.
 * Used by StatusPill when given a custom hex outside the palette.
 */
export function contrastingTextColor(hex) {
  if (!hex || typeof hex !== 'string') return '#ffffff';
  const cleaned = hex.replace('#', '');
  if (cleaned.length !== 6) return '#ffffff';
  const r = parseInt(cleaned.slice(0, 2), 16);
  const g = parseInt(cleaned.slice(2, 4), 16);
  const b = parseInt(cleaned.slice(4, 6), 16);
  // sRGB luminance approximation. Threshold 0.6 favors white text slightly
  // so that mid-tone fills (orange, teal) stay legible.
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#1f1f1f' : '#ffffff';
}

/**
 * Brand gradient used on AI inputs (skill §12.3).
 */
export const BRAND_GRADIENT = 'linear-gradient(135deg, #9d50dd 0%, #579bfc 33%, #00c875 66%, #ffcb00 100%)';
