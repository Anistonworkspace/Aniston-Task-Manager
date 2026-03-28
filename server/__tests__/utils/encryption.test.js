/**
 * Unit tests for server/utils/encryption.js
 *
 * No mocks are used — the module uses Node's built-in `crypto` package which
 * works without a database or external services. Tests verify:
 *   - encrypt() returns a non-null string in iv:authTag:ciphertext format
 *   - encrypt() produces a different ciphertext on each call (random IV)
 *   - decrypt() recovers the original plaintext from an encrypted string
 *   - Round-trip (encrypt → decrypt) works for various input strings
 *   - encrypt(null/undefined/'') returns null
 *   - decrypt(null/undefined/'') returns null
 *   - decrypt() throws on malformed input (wrong segment count)
 *   - decrypt() throws (GCM auth tag mismatch) when given the wrong key
 *   - maskSecret() masks all but the last 4 characters
 *   - getKey() (indirectly) throws when ENCRYPTION_KEY is missing
 */

'use strict';

// ─── Generate a valid 256-bit test key before loading the module ──────────────
const crypto = require('crypto');
const TEST_KEY = crypto.randomBytes(32).toString('hex'); // 64 hex chars = 32 bytes

describe('encryption utils', () => {
  let encrypt, decrypt, maskSecret;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = TEST_KEY;
    // Load module after setting env var so getKey() succeeds
    ({ encrypt, decrypt, maskSecret } = require('../../utils/encryption'));
  });

  afterAll(() => {
    delete process.env.ENCRYPTION_KEY;
  });

  // ── encrypt() ─────────────────────────────────────────────────────────────

  describe('encrypt()', () => {
    it('returns a non-null string for a normal plaintext input', () => {
      const result = encrypt('hello world');
      expect(result).not.toBeNull();
      expect(typeof result).toBe('string');
    });

    it('returns a string in "iv:authTag:ciphertext" format (3 colon-separated segments)', () => {
      const result = encrypt('test value');
      const parts = result.split(':');
      expect(parts).toHaveLength(3);
    });

    it('encodes iv as a 32-char hex string (16 bytes)', () => {
      const result = encrypt('test');
      const iv = result.split(':')[0];
      expect(iv).toHaveLength(32); // 16 bytes * 2 hex chars
      expect(iv).toMatch(/^[0-9a-f]+$/i);
    });

    it('encodes authTag as a 32-char hex string (16 bytes)', () => {
      const result = encrypt('test');
      const authTag = result.split(':')[1];
      expect(authTag).toHaveLength(32);
      expect(authTag).toMatch(/^[0-9a-f]+$/i);
    });

    it('produces a different ciphertext on each call (random IV)', () => {
      const first = encrypt('same plaintext');
      const second = encrypt('same plaintext');
      // Different IVs guarantee different outputs
      expect(first).not.toBe(second);
    });

    it('returns null for null input', () => {
      expect(encrypt(null)).toBeNull();
    });

    it('returns null for undefined input', () => {
      expect(encrypt(undefined)).toBeNull();
    });

    it('returns null for empty string input', () => {
      expect(encrypt('')).toBeNull();
    });

    it('handles unicode and special characters', () => {
      const result = encrypt('Hello 🌍 "special" <chars> & more');
      expect(result).not.toBeNull();
      const parts = result.split(':');
      expect(parts).toHaveLength(3);
    });

    it('handles a very long string', () => {
      const longString = 'a'.repeat(10000);
      const result = encrypt(longString);
      expect(result).not.toBeNull();
      expect(result.split(':')).toHaveLength(3);
    });
  });

  // ── decrypt() ─────────────────────────────────────────────────────────────

  describe('decrypt()', () => {
    it('recovers the original plaintext from an encrypted value', () => {
      const plaintext = 'my secret token';
      const encrypted = encrypt(plaintext);
      expect(decrypt(encrypted)).toBe(plaintext);
    });

    it('returns null for null input', () => {
      expect(decrypt(null)).toBeNull();
    });

    it('returns null for undefined input', () => {
      expect(decrypt(undefined)).toBeNull();
    });

    it('returns null for empty string input', () => {
      expect(decrypt('')).toBeNull();
    });

    it('throws for input with fewer than 3 colon-separated parts', () => {
      expect(() => decrypt('onlyone')).toThrow('Invalid encrypted text format');
      expect(() => decrypt('two:parts')).toThrow('Invalid encrypted text format');
    });

    it('throws for input with more than 3 colon-separated parts', () => {
      expect(() => decrypt('a:b:c:d')).toThrow('Invalid encrypted text format');
    });
  });

  // ── Round-trip tests ───────────────────────────────────────────────────────

  describe('encrypt → decrypt round-trip', () => {
    const testCases = [
      'simple string',
      'email@example.com',
      'Bearer eyJhbGciOiJSUzI1NiJ9.payload.signature',
      '{"json":"value","number":42}',
      'multi\nline\nstring',
      '   spaces   around   ',
      '12345',
      'a', // single character
    ];

    testCases.forEach(input => {
      it(`correctly round-trips: "${input.slice(0, 40)}"`, () => {
        expect(decrypt(encrypt(input))).toBe(input);
      });
    });
  });

  // ── Wrong key / tampered data ──────────────────────────────────────────────

  describe('decrypt() with wrong key', () => {
    it('throws when decrypting with a different key (GCM auth tag mismatch)', () => {
      // Encrypt with the current TEST_KEY
      const encrypted = encrypt('secret data');

      // Switch to a different key
      const wrongKey = crypto.randomBytes(32).toString('hex');
      process.env.ENCRYPTION_KEY = wrongKey;

      // Jest module cache holds the old closure — reload to pick up the new key
      jest.resetModules();
      const { decrypt: decryptWithWrongKey } = require('../../utils/encryption');

      expect(() => decryptWithWrongKey(encrypted)).toThrow();

      // Restore the original test key
      process.env.ENCRYPTION_KEY = TEST_KEY;
    });
  });

  // ── maskSecret() ──────────────────────────────────────────────────────────

  describe('maskSecret()', () => {
    it('returns an empty string for null input', () => {
      expect(maskSecret(null)).toBe('');
    });

    it('returns an empty string for undefined input', () => {
      expect(maskSecret(undefined)).toBe('');
    });

    it('returns an empty string for empty string input', () => {
      expect(maskSecret('')).toBe('');
    });

    it('returns "••••" for a string of 4 or fewer characters', () => {
      expect(maskSecret('abcd')).toBe('••••');
      expect(maskSecret('abc')).toBe('••••');
      expect(maskSecret('a')).toBe('••••');
    });

    it('shows only the last 4 characters for longer strings', () => {
      const result = maskSecret('mysecrettoken1234');
      expect(result).toMatch(/1234$/);
      expect(result).toContain('••••••••');
      expect(result).not.toContain('mysecret');
    });

    it('produces the correct mask prefix for a 10-character string', () => {
      // "abcdefghij" -> "••••••••ghij"
      const result = maskSecret('abcdefghij');
      expect(result).toBe('••••••••ghij');
    });

    it('does not expose sensitive characters in the middle of the string', () => {
      const result = maskSecret('super-sensitive-value-END');
      expect(result).toMatch(/-END$/);
      expect(result).not.toContain('super');
    });
  });

  // ── Missing ENCRYPTION_KEY ────────────────────────────────────────────────

  describe('when ENCRYPTION_KEY is missing', () => {
    it('encrypt() throws a descriptive error', () => {
      const savedKey = process.env.ENCRYPTION_KEY;
      delete process.env.ENCRYPTION_KEY;

      jest.resetModules();
      const { encrypt: encryptNoKey } = require('../../utils/encryption');

      expect(() => encryptNoKey('anything')).toThrow('ENCRYPTION_KEY environment variable is not set');

      process.env.ENCRYPTION_KEY = savedKey;
    });

    it('decrypt() throws a descriptive error', () => {
      const savedKey = process.env.ENCRYPTION_KEY;
      delete process.env.ENCRYPTION_KEY;

      jest.resetModules();
      const { decrypt: decryptNoKey } = require('../../utils/encryption');

      expect(() => decryptNoKey('iv:tag:cipher')).toThrow('ENCRYPTION_KEY environment variable is not set');

      process.env.ENCRYPTION_KEY = savedKey;
    });
  });
});
