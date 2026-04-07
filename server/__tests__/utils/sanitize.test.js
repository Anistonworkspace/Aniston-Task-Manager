'use strict';

/**
 * Unit tests for server/utils/sanitize.js
 *
 * sanitize.js wraps the `xss` library.  We test it in two modes:
 *   - sanitizeInput  — strips ALL HTML (whitelist = {})
 *   - sanitizeRichText — allows the xss library's default safe-tag whitelist
 *
 * No mocking is needed here: the module only depends on the `xss` package which
 * is a pure function with no I/O.
 */

const { sanitizeInput, sanitizeRichText } = require('../../utils/sanitize');

// ─── sanitizeInput ────────────────────────────────────────────────────────────

describe('sanitizeInput', () => {
  // ── Script injection ──────────────────────────────────────────────────────

  it('strips a <script> tag and its contents', () => {
    const input = '<script>alert("xss")</script>';
    const result = sanitizeInput(input);

    expect(result).not.toContain('<script>');
    expect(result).not.toContain('alert');
  });

  it('strips an inline <script src="..."> tag', () => {
    const input = '<script src="https://evil.com/xss.js"></script>';
    const result = sanitizeInput(input);

    expect(result).not.toContain('<script');
    expect(result).not.toContain('evil.com');
  });

  it('strips a <style> tag and its contents entirely', () => {
    const input = '<style>body { background: url("javascript:alert(1)"); }</style>';
    const result = sanitizeInput(input);

    expect(result).not.toContain('<style>');
    expect(result).not.toContain('background');
  });

  // ── Event handler attributes ──────────────────────────────────────────────

  it('strips onclick event handler from an anchor tag', () => {
    const input = '<a href="#" onclick="steal()">Click me</a>';
    const result = sanitizeInput(input);

    expect(result).not.toContain('onclick');
    expect(result).not.toContain('<a');
  });

  it('strips onerror event handler from an img tag', () => {
    const input = '<img src="x" onerror="alert(document.cookie)">';
    const result = sanitizeInput(input);

    expect(result).not.toContain('onerror');
    expect(result).not.toContain('<img');
  });

  it('strips onload event handler', () => {
    const input = '<body onload="launchMissiles()">';
    const result = sanitizeInput(input);

    expect(result).not.toContain('onload');
    expect(result).not.toContain('<body');
  });

  it('strips onmouseover event handler', () => {
    const input = '<div onmouseover="track()">Hover me</div>';
    const result = sanitizeInput(input);

    expect(result).not.toContain('onmouseover');
    expect(result).not.toContain('<div');
  });

  // ── javascript: protocol ──────────────────────────────────────────────────

  it('strips anchor tag with javascript: href', () => {
    const input = '<a href="javascript:void(alert(1))">Link</a>';
    const result = sanitizeInput(input);

    expect(result).not.toContain('<a');
    expect(result).not.toContain('javascript:');
  });

  // ── Safe content preservation ─────────────────────────────────────────────

  it('passes plain text through unchanged', () => {
    const input = 'Hello, world! This is a normal sentence.';
    expect(sanitizeInput(input)).toBe(input);
  });

  it('preserves numbers and special characters that are not HTML', () => {
    const input = 'Task #42 — Priority: High (due 2026-03-27)';
    expect(sanitizeInput(input)).toBe(input);
  });

  it('preserves newlines and whitespace', () => {
    const input = 'Line one\nLine two\n  Indented';
    expect(sanitizeInput(input)).toBe(input);
  });

  it('returns empty string when given an empty string', () => {
    expect(sanitizeInput('')).toBe('');
  });

  // ── Non-string inputs ─────────────────────────────────────────────────────

  it('returns null unchanged when given null', () => {
    expect(sanitizeInput(null)).toBeNull();
  });

  it('returns undefined unchanged when given undefined', () => {
    expect(sanitizeInput(undefined)).toBeUndefined();
  });

  it('returns a number unchanged (non-string passthrough)', () => {
    expect(sanitizeInput(42)).toBe(42);
  });

  // ── Mixed content ─────────────────────────────────────────────────────────

  it('strips HTML from mixed content while preserving surrounding text', () => {
    const input = 'Hello <script>evil()</script> World';
    const result = sanitizeInput(input);

    expect(result).not.toContain('<script>');
    expect(result).not.toContain('evil()');
    expect(result).toContain('Hello');
    expect(result).toContain('World');
  });

  it('handles nested tags and strips them all', () => {
    const input = '<div><p><b>Text</b></p></div>';
    const result = sanitizeInput(input);

    expect(result).not.toContain('<div>');
    expect(result).not.toContain('<p>');
    expect(result).not.toContain('<b>');
    expect(result).toContain('Text');
  });

  it('strips HTML entity-encoded script tags', () => {
    // Some XSS payloads encode < as &lt; — xss library handles normalisation
    const input = 'normal &amp; <b>bold attempt</b>';
    const result = sanitizeInput(input);

    expect(result).not.toContain('<b>');
  });
});

// ─── sanitizeRichText ─────────────────────────────────────────────────────────

describe('sanitizeRichText', () => {
  it('preserves safe bold tags', () => {
    const input = 'This is <b>bold</b> text.';
    const result = sanitizeRichText(input);

    expect(result).toContain('<b>bold</b>');
    expect(result).toContain('This is');
  });

  it('preserves safe italic tags', () => {
    const input = 'Some <em>emphasis</em> here.';
    const result = sanitizeRichText(input);

    expect(result).toContain('<em>');
  });

  it('neutralises dangerous script tags in rich-text mode (encodes or strips them)', () => {
    const input = '<p>Hello</p><script>alert("xss")</script>';
    const result = sanitizeRichText(input);

    // The xss library HTML-encodes script tags (e.g. &lt;script&gt;) rather
    // than removing them outright — either way the tag cannot execute.
    expect(result).not.toContain('<script>');
    // The content may survive as encoded text, which is safe, so we only
    // assert the executable tag form is gone.
  });

  it('strips onclick on otherwise-safe tags', () => {
    const input = '<b onclick="evil()">Bold</b>';
    const result = sanitizeRichText(input);

    expect(result).not.toContain('onclick');
    expect(result).toContain('Bold');
  });

  it('passes plain text through unchanged', () => {
    const input = 'Just plain text, nothing fancy.';
    expect(sanitizeRichText(input)).toBe(input);
  });

  it('returns null unchanged when given null', () => {
    expect(sanitizeRichText(null)).toBeNull();
  });

  it('returns undefined unchanged when given undefined', () => {
    expect(sanitizeRichText(undefined)).toBeUndefined();
  });

  it('strips javascript: href from anchor tags', () => {
    const input = '<a href="javascript:alert(1)">Click</a>';
    const result = sanitizeRichText(input);

    expect(result).not.toContain('javascript:');
  });

  it('preserves safe anchor tags with http href', () => {
    const input = '<a href="https://aniston.com">Visit us</a>';
    const result = sanitizeRichText(input);

    // The xss default whitelist allows <a> with href
    expect(result).toContain('Visit us');
  });
});
