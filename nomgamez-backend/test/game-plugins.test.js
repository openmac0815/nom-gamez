const test = require('node:test');
const assert = require('node:assert/strict');

const { getGamePlugin, buildDefaultGameConfig, getGameSessionMetadata, getPublicGameDefinitions } = require('../games');
const { verifyGameResult, seededInt } = require('../verifier');

test('game registry exposes built-in plugins and config defaults', () => {
  const defaults = buildDefaultGameConfig();
  assert.equal(defaults.dice.name, 'Hash Dice');
  assert.equal(defaults.slots.active, true);
  assert.equal(defaults.shooter.active, false);

  const publicDefs = getPublicGameDefinitions();
  assert.equal(publicDefs.some((game) => game.id === 'dice'), true);
  assert.equal(publicDefs.some((game) => game.id === 'slots'), true);
  assert.equal(publicDefs.some((game) => game.id === 'shooter'), true);
});

test('dice plugin verifies deterministic proof through registry', () => {
  const session = { id: 'session-dice', gameId: 'dice' };
  const roll = seededInt(session.id, 'dice:roll', 100);
  const result = verifyGameResult(session, {
    proof: { modeId: 'over50', claimedRoll: roll },
  });

  assert.equal(result.valid, true);
  assert.equal(result.details.roll, roll);
});

test('slots plugin verifies deterministic proof through registry', () => {
  const session = { id: 'session-slots', gameId: 'slots' };
  const plugin = getGamePlugin('slots');
  const metadata = getGameSessionMetadata('slots');
  assert.equal(metadata.client.view, 'slots');

  const expected = plugin.verifyResult(session, { proof: {} }, { seededInt });
  const replay = verifyGameResult(session, {
    proof: {
      reels: expected.details.reels,
      multiplier: expected.details.multiplier,
    },
  });

  assert.equal(replay.valid, true);
  assert.deepEqual(replay.details.reels, expected.details.reels);
});

test('shooter plugin stays modular but disabled', () => {
  const result = verifyGameResult({ id: 'session-shooter', gameId: 'shooter' }, { proof: {} });
  assert.equal(result.valid, false);
  assert.match(result.reason, /disabled/i);
});
