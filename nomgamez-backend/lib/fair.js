/**
 * NOM-GAMEZ — Provably Fair PRNG Module
 *
 * Uses HMAC-SHA256 commit-reveal scheme:
 *   1. Server commits to H(serverSeed) at session creation
 *   2. Client supplies clientSeed + nonce
 *   3. Outcome = HMAC-SHA256(serverSeed, clientSeed || ':' || nonce || ':' || label)
 *   4. After round, server reveals serverSeed for verification
 *
 * Anyone can recompute the outcome client-side to verify fairness.
 */

const crypto = require('crypto');

/**
 * Generate a cryptographically secure random server seed (32 bytes)
 * @returns {string} Hex-encoded 64-char seed
 */
function generateServerSeed() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Create a commitment hash from the server seed
 * Stored/returned at session creation; reveal after round
 * @param {string} serverSeed - Hex-encoded server seed
 * @returns {string} SHA256 hash (hex)
 */
function commit(serverSeed) {
  if (!serverSeed || typeof serverSeed !== 'string') {
    throw new Error('serverSeed must be a non-empty hex string');
  }
  return crypto.createHash('sha256').update(serverSeed, 'hex').digest('hex');
}

/**
 * Compute HMAC-SHA256(serverSeed, message)
 * @param {string} serverSeed - Hex-encoded server seed
 * @param {string} message - Message to HMAC
 * @returns {string} HMAC-SHA256 digest (hex)
 */
function hmacSha256(serverSeed, message) {
  if (!serverSeed || !message) {
    throw new Error('serverSeed and message are required');
  }
  return crypto
    .createHmac('sha256', Buffer.from(serverSeed, 'hex'))
    .update(message, 'utf8')
    .digest('hex');
}

/**
 * Derive a deterministic outcome from serverSeed + clientSeed + nonce + label
 * @param {string} serverSeed - Hex-encoded server seed (revealed after round)
 * @param {string} clientSeed - Client-provided seed (any string)
 * @param {string|number} nonce - Round/increment nonce (prevents reuse)
 * @param {string} label - Game identifier (e.g., 'dice', 'coinflip')
 * @returns {string} HMAC-SHA256 hex digest
 */
function outcome(serverSeed, clientSeed, nonce, label) {
  const message = [clientSeed, nonce, label].join(':');
  return hmacSha256(serverSeed, message);
}

/**
 * Convert a hash (hex) to an integer in [0, max)
 * @param {string} hash - Hex hash (at least 8 chars)
 * @param {number} max - Upper bound (exclusive)
 * @param {number} [offset=0] - Byte offset into hash (default 0)
 * @returns {number} Integer in [0, max)
 */
function toInt(hash, max, offset = 0) {
  const slice = hash.slice(offset, offset + 8);
  const intVal = parseInt(slice, 16);
  return intVal % max;
}

/**
 * Convert a hash (hex) to a float in [0, 1)
 * @param {string} hash - Hex hash (at least 8 chars)
 * @param {number} [offset=0] - Byte offset into hash
 * @returns {number} Float in [0, 1)
 */
function toFloat(hash, offset = 0) {
  const slice = hash.slice(offset, offset + 8);
  const intVal = parseInt(slice, 16);
  return intVal / 0x100000000; // 2^32
}

/**
 * Generate a roll result (0 to max-1) using serverSeed + clientSeed + nonce
 * @param {string} serverSeed
 * @param {string} clientSeed
 * @param {string|number} nonce
 * @param {string} label
 * @param {number} max
 * @returns {number}
 */
function roll(serverSeed, clientSeed, nonce, label, max) {
  const hash = outcome(serverSeed, clientSeed, nonce, label);
  return toInt(hash, max);
}

/**
 * Generate a float in [0,1) using same inputs
 * @param {string} serverSeed
 * @param {string} clientSeed
 * @param {string|number} nonce
 * @param {string} label
 * @returns {number}
 */
function rollFloat(serverSeed, clientSeed, nonce, label) {
  const hash = outcome(serverSeed, clientSeed, nonce, label);
  return toFloat(hash);
}

/**
 * Build a verification object for client-side replay
 * @param {string} serverSeed
 * @param {string} clientSeed
 * @param {string|number} nonce
 * @param {string} label
 * @returns {object} { serverSeed, clientSeed, nonce, label, hash, commitment }
 */
function buildVerification(serverSeed, clientSeed, nonce, label) {
  const hash = outcome(serverSeed, clientSeed, nonce, label);
  return {
    serverSeed,
    clientSeed,
    nonce,
    label,
    hash,
    commitment: commit(serverSeed),
  };
}

module.exports = {
  generateServerSeed,
  commit,
  hmacSha256,
  outcome,
  toInt,
  toFloat,
  roll,
  rollFloat,
  buildVerification,
};
