'use strict';

/**
 * Unit tests for the upload validation primitives.
 *
 * These functions are pure(-ish) — they read a file from disk and return a
 * `{valid, message}` verdict. We exercise them by writing tiny temp files
 * containing the relevant byte sequences / XML markup and asserting the
 * verdict, with no Multer / Express plumbing in the way.
 *
 * Coverage targets:
 *   - validateMagicBytes: PNG, JPEG, PDF accept; mismatched bytes reject
 *   - validateSvgSafety:  <script>, on*=, javascript:, <!ENTITY> all reject;
 *                         a plain safe SVG accepts
 *   - BLOCKED_EXTENSIONS: contains the dangerous + web-content sets
 *   - validateFileType:   blocked extensions rejected regardless of MIME
 */

process.env.LOG_LEVEL = 'error';

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  validateMagicBytes,
  validateSvgSafety,
  validateFileType,
  validateFileSize,
} = require('../../services/storageService');
const { BLOCKED_EXTENSIONS } = require('../../config/fileTypes');

// ─── Test-file helpers ───────────────────────────────────────────────────

function writeTemp(name, bytesOrText) {
  const filePath = path.join(os.tmpdir(), `aniston-upload-test-${Date.now()}-${Math.random()}-${name}`);
  if (Buffer.isBuffer(bytesOrText)) {
    fs.writeFileSync(filePath, bytesOrText);
  } else {
    fs.writeFileSync(filePath, bytesOrText, 'utf8');
  }
  return filePath;
}

const created = [];
function tempFile(name, content) {
  const p = writeTemp(name, content);
  created.push(p);
  return p;
}

afterAll(() => {
  for (const p of created) {
    try { fs.unlinkSync(p); } catch { /* best effort */ }
  }
});

// ─── validateMagicBytes ──────────────────────────────────────────────────

describe('validateMagicBytes', () => {
  it('accepts a PNG file whose first bytes are 89 50 4E 47', () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
      Buffer.alloc(64, 0),
    ]);
    const filePath = tempFile('test.png', png);
    expect(validateMagicBytes(filePath, 'test.png')).toEqual({ valid: true });
  });

  it('accepts a JPEG file whose first bytes are FF D8 FF', () => {
    const jpeg = Buffer.concat([
      Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]),
      Buffer.alloc(64, 0),
    ]);
    const filePath = tempFile('test.jpg', jpeg);
    expect(validateMagicBytes(filePath, 'test.jpg')).toEqual({ valid: true });
  });

  it('accepts a PDF file whose first bytes are %PDF (25 50 44 46)', () => {
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.7\n', 'utf8'),
      Buffer.alloc(64, 0),
    ]);
    const filePath = tempFile('test.pdf', pdf);
    expect(validateMagicBytes(filePath, 'test.pdf')).toEqual({ valid: true });
  });

  it('rejects a file claiming to be PNG that actually contains plain text', () => {
    const filePath = tempFile('fake.png', 'this is just a text file, not a PNG\n');
    const result = validateMagicBytes(filePath, 'fake.png');
    expect(result.valid).toBe(false);
    expect(result.message).toMatch(/does not match/i);
  });

  it('skips magic-byte enforcement for extensions with no signature (e.g. txt)', () => {
    const filePath = tempFile('notes.txt', 'hello world');
    expect(validateMagicBytes(filePath, 'notes.txt')).toEqual({ valid: true });
  });
});

// ─── validateSvgSafety ───────────────────────────────────────────────────

describe('validateSvgSafety', () => {
  const validHeader = '<?xml version="1.0" encoding="UTF-8"?>\n';

  it('accepts a plain, safe SVG with no scripts or event handlers', () => {
    const safe = validHeader +
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">' +
      '<rect width="100" height="100" fill="blue"/></svg>';
    const filePath = tempFile('safe.svg', safe);
    expect(validateSvgSafety(filePath, 'safe.svg')).toEqual({ valid: true });
  });

  it('rejects SVG containing <script>', () => {
    const hostile = validHeader +
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    const filePath = tempFile('xss-script.svg', hostile);
    const result = validateSvgSafety(filePath, 'xss-script.svg');
    expect(result.valid).toBe(false);
    expect(result.message).toMatch(/<script>/i);
  });

  it('rejects SVG containing an inline event handler like onclick=', () => {
    const hostile = validHeader +
      '<svg xmlns="http://www.w3.org/2000/svg"><circle r="10" onclick="alert(1)"/></svg>';
    const filePath = tempFile('xss-onclick.svg', hostile);
    const result = validateSvgSafety(filePath, 'xss-onclick.svg');
    expect(result.valid).toBe(false);
    expect(result.message).toMatch(/event handler/i);
  });

  it('rejects SVG with a javascript: URI in href/src/xlink:href', () => {
    const hostile = validHeader +
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' +
      '<a xlink:href="javascript:alert(1)"><text>x</text></a></svg>';
    const filePath = tempFile('xss-jsuri.svg', hostile);
    const result = validateSvgSafety(filePath, 'xss-jsuri.svg');
    expect(result.valid).toBe(false);
    expect(result.message).toMatch(/javascript:/i);
  });

  it('rejects SVG containing an XML entity declaration (XXE risk)', () => {
    const hostile =
      '<?xml version="1.0"?>\n' +
      '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>\n' +
      '<svg xmlns="http://www.w3.org/2000/svg"><text>&xxe;</text></svg>';
    const filePath = tempFile('xxe.svg', hostile);
    const result = validateSvgSafety(filePath, 'xxe.svg');
    expect(result.valid).toBe(false);
    expect(result.message).toMatch(/entity|DTD|XXE/i);
  });

  it('returns valid:true for non-SVG files (no-op)', () => {
    const filePath = tempFile('plain.txt', 'just text');
    expect(validateSvgSafety(filePath, 'plain.txt')).toEqual({ valid: true });
  });
});

// ─── BLOCKED_EXTENSIONS + validateFileType ───────────────────────────────

describe('BLOCKED_EXTENSIONS list', () => {
  it('includes native executables and shell scripts', () => {
    expect(BLOCKED_EXTENSIONS).toEqual(expect.arrayContaining([
      'exe', 'bat', 'cmd', 'msi', 'scr', 'vbs', 'jar',
    ]));
  });

  it('includes browser-active web content (P0-3 same-origin XSS guard)', () => {
    expect(BLOCKED_EXTENSIONS).toEqual(expect.arrayContaining([
      'html', 'htm', 'xhtml', 'js', 'mjs', 'cjs', 'css', 'xml', 'svg',
    ]));
  });
});

describe('validateFileType — blocked-extension short-circuit', () => {
  it('rejects an .exe upload even when the MIME claims something benign', () => {
    const file = { originalname: 'evil.exe', mimetype: 'application/octet-stream' };
    const result = validateFileType(file, 'task_attachment');
    expect(result.valid).toBe(false);
    expect(result.message).toMatch(/security/i);
  });

  it('rejects an .html upload to any category (same-origin XSS prevention)', () => {
    const file = { originalname: 'evil.html', mimetype: 'text/html' };
    const result = validateFileType(file, 'task_attachment');
    expect(result.valid).toBe(false);
  });

  it('rejects an .js upload (now in BLOCKED_EXTENSIONS post P0-3)', () => {
    const file = { originalname: 'evil.js', mimetype: 'application/javascript' };
    const result = validateFileType(file, 'general');
    expect(result.valid).toBe(false);
  });

  it('accepts a permitted extension+MIME for the matching category', () => {
    const file = { originalname: 'photo.png', mimetype: 'image/png' };
    const result = validateFileType(file, 'avatar');
    expect(result.valid).toBe(true);
  });
});

// ─── validateFileSize ────────────────────────────────────────────────────

describe('validateFileSize', () => {
  it('accepts files within the category limit', () => {
    const file = { size: 1024 }; // 1 KB << 25 MB default
    expect(validateFileSize(file, 'general')).toEqual({ valid: true });
  });

  it('rejects files that exceed the avatar 5 MB cap', () => {
    const file = { size: 10 * 1024 * 1024 }; // 10 MB
    const result = validateFileSize(file, 'avatar');
    expect(result.valid).toBe(false);
    expect(result.message).toMatch(/too large/i);
  });
});
