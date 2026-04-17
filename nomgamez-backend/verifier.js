const { getGamePlugin } = require('./games');

function seededInt(seed, nonce, max) {
  let h = 0x12345678;
  const s = `${seed}:${nonce}`;
  for (let i = 0; i < s.length; i++) h = Math.imul(31, h) + s.charCodeAt(i) | 0;
  return (Math.abs(h) % max) + 1;
}

function verifyGameResult(session, payload = {}) {
  const plugin = getGamePlugin(session.gameId);
  if (!plugin || typeof plugin.verifyResult !== 'function') {
    return { valid: false, reason: `Unsupported game: ${session.gameId}` };
  }
  return plugin.verifyResult(session, payload, { seededInt });
}

module.exports = {
  verifyGameResult,
  seededInt,
};
