'use strict';

/**
 * Utility for building safe Sequelize literal expressions.
 *
 * Problem: Using string interpolation like `sequelize.literal(\`... WHERE userId = '${id}'\`)`
 * is vulnerable to SQL injection if `id` is ever user-controlled or tampered with.
 * Even JWT-sourced UUIDs should not be interpolated — defense in depth.
 *
 * Solution: Validate UUIDs before embedding them. This module provides helpers
 * that assert UUID format before building literal SQL, preventing injection.
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Assert that a value is a valid UUID. Throws if not.
 * @param {string} value
 * @param {string} [label] - descriptive label for error messages
 * @returns {string} the validated UUID
 */
function assertUUID(value, label = 'value') {
  if (typeof value !== 'string' || !UUID_REGEX.test(value)) {
    throw new Error(`[SafeSQL] Invalid UUID for ${label}: ${String(value).slice(0, 50)}`);
  }
  return value;
}

/**
 * Validate and quote a UUID for safe embedding in SQL literals.
 * @param {string} uuid
 * @param {string} [label]
 * @returns {string} e.g. "'a1b2c3d4-...'"
 */
function safeUUID(uuid, label) {
  return `'${assertUUID(uuid, label)}'`;
}

/**
 * Build a safe SQL IN-list from an array of UUIDs.
 * @param {string[]} uuids
 * @param {string} [label]
 * @returns {string} e.g. "'uuid1','uuid2','uuid3'"
 */
function safeUUIDList(uuids, label = 'uuid list') {
  if (!Array.isArray(uuids) || uuids.length === 0) {
    throw new Error(`[SafeSQL] Empty UUID list for ${label}`);
  }
  return uuids.map((id, i) => safeUUID(id, `${label}[${i}]`)).join(',');
}

module.exports = { assertUUID, safeUUID, safeUUIDList, UUID_REGEX };
