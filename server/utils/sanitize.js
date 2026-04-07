const xss = require('xss');

/**
 * Sanitize user input to prevent XSS attacks.
 * Strips dangerous HTML tags and attributes while preserving safe text.
 */
function sanitizeInput(str) {
  if (!str || typeof str !== 'string') return str;
  return xss(str, {
    whiteList: {},       // No HTML tags allowed
    stripIgnoreTag: true, // Strip all tags
    stripIgnoreTagBody: ['script', 'style'], // Remove script/style content entirely
  });
}

/**
 * Sanitize allowing basic formatting (bold, italic, links).
 * Use for rich-text fields like descriptions.
 */
function sanitizeRichText(str) {
  if (!str || typeof str !== 'string') return str;
  return xss(str); // Default xss whitelist allows basic safe tags
}

module.exports = { sanitizeInput, sanitizeRichText };
