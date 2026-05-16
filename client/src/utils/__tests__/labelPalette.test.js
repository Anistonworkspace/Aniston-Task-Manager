import { describe, it, expect } from 'vitest';
import {
  LABEL_PALETTE,
  PALETTE_ORDER,
  resolvePaletteColor,
  hashToPaletteToken,
  contrastingTextColor,
  BRAND_GRADIENT,
} from '../labelPalette';

describe('labelPalette', () => {
  it('exports all 9 palette tokens in canonical order', () => {
    expect(PALETTE_ORDER).toEqual([
      'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'gray',
    ]);
    for (const token of PALETTE_ORDER) {
      expect(LABEL_PALETTE[token]).toBeDefined();
      expect(LABEL_PALETTE[token].bg).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('resolves a palette token to its entry', () => {
    expect(resolvePaletteColor('red')).toBe(LABEL_PALETTE.red);
    expect(resolvePaletteColor('green')).toBe(LABEL_PALETTE.green);
  });

  it('falls back to gray for unknown input', () => {
    expect(resolvePaletteColor()).toBe(LABEL_PALETTE.gray);
    expect(resolvePaletteColor('not-a-color')).toBe(LABEL_PALETTE.gray);
  });

  it('maps a palette hex back to its canonical entry', () => {
    expect(resolvePaletteColor('#df2f4a')).toBe(LABEL_PALETTE.red);
    expect(resolvePaletteColor('#DF2F4A')).toBe(LABEL_PALETTE.red);
  });

  it('synthesizes a gray-based entry for non-palette hex input', () => {
    const entry = resolvePaletteColor('#123456');
    expect(entry.bg).toBe('#123456');
    expect(entry.border).toBe('#123456');
  });

  it('hashes consistently to a vibrant palette token (never gray)', () => {
    const tokenA = hashToPaletteToken('Inbound Sales');
    const tokenB = hashToPaletteToken('Inbound Sales');
    expect(tokenA).toBe(tokenB);
    expect(tokenA).not.toBe('gray');
  });

  it('uses gray for null/empty names', () => {
    expect(hashToPaletteToken('')).toBe('gray');
    expect(hashToPaletteToken(null)).toBe('gray');
    expect(hashToPaletteToken(undefined)).toBe('gray');
  });

  it('picks white text on dark bg and dark text on light bg', () => {
    expect(contrastingTextColor('#000000')).toBe('#ffffff');
    expect(contrastingTextColor('#ffffff')).toBe('#1f1f1f');
    expect(contrastingTextColor('#df2f4a')).toBe('#ffffff'); // red — needs white
    expect(contrastingTextColor('#ffcb00')).toBe('#1f1f1f'); // yellow — needs dark
  });

  it('returns white on invalid hex (defensive)', () => {
    expect(contrastingTextColor()).toBe('#ffffff');
    expect(contrastingTextColor('not-hex')).toBe('#ffffff');
    expect(contrastingTextColor('#abc')).toBe('#ffffff');
  });

  it('exposes the brand gradient string for AI inputs', () => {
    expect(BRAND_GRADIENT).toMatch(/linear-gradient/);
    expect(BRAND_GRADIENT).toContain('#9d50dd');
    expect(BRAND_GRADIENT).toContain('#ffcb00');
  });
});
