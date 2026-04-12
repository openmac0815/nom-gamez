const fs = require('fs');
const path = require('path');

class PersistentStateStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.dir = path.dirname(filePath);
    this.saveTimer = null;
    this.saveDelayMs = 200;
    this.snapshotProvider = null;
  }

  setSnapshotProvider(provider) {
    this.snapshotProvider = provider;
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) return null;
      return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch (err) {
      console.error('[storage] Failed to load state:', err.message);
      return null;
    }
  }

  scheduleSave() {
    if (!this.snapshotProvider) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), this.saveDelayMs);
  }

  saveNow() {
    if (!this.snapshotProvider) return;

    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const snapshot = this.snapshotProvider();
      const tempPath = `${this.filePath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(snapshot, null, 2));
      fs.renameSync(tempPath, this.filePath);
    } catch (err) {
      console.error('[storage] Failed to persist state:', err.message);
    }
  }
}

module.exports = { PersistentStateStore };
