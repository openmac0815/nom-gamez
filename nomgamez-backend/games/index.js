const { createDicePlugin } = require('./dice');
const { createSlotsPlugin } = require('./slots');
const { createShooterPlugin } = require('./shooter');

const pluginFactories = [
  createDicePlugin,
  createSlotsPlugin,
  createShooterPlugin,
];

const plugins = new Map(pluginFactories.map((factory) => {
  const plugin = factory();
  return [plugin.id, plugin];
}));

function listGamePlugins() {
  return Array.from(plugins.values());
}

function getGamePlugin(gameId) {
  return plugins.get(gameId) || null;
}

function buildDefaultGameConfig() {
  return Object.fromEntries(
    listGamePlugins().map((plugin) => [
      plugin.id,
      {
        id: plugin.id,
        name: plugin.name,
        ...plugin.defaultConfig,
      },
    ])
  );
}

function getGameSessionMetadata(gameId) {
  const plugin = getGamePlugin(gameId);
  if (!plugin) return null;
  return plugin.getSessionMetadata ? plugin.getSessionMetadata() : { verification: plugin.verification || null };
}

function getPublicGameDefinitions() {
  return listGamePlugins().map((plugin) => ({
    id: plugin.id,
    name: plugin.name,
    defaultConfig: plugin.defaultConfig,
    verification: plugin.verification || null,
  }));
}

module.exports = {
  listGamePlugins,
  getGamePlugin,
  buildDefaultGameConfig,
  getGameSessionMetadata,
  getPublicGameDefinitions,
};
