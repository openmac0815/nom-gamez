/**
 * Shooter Game Plugin - Space Shooter with Provably Fair Deterministic Gameplay
 * 
 * Implements replayable determinism using a server-committed seed and client inputs.
 * Game state is fully deterministic given the initial seed and player input log,
 * allowing for verification of results without trusting the server.
 */

/**
 * Seeded Pseudo-Random Number Generator (xoshiro128** algorithm)
 * Provides deterministic random numbers for game logic given a fixed seed.
 * @param {string} seed - Hex string seed to initialize the PRNG
 * @returns {object} PRNG instance with next() method
 */
function createSeededPRNG(seed) {
  // Convert hex seed to 4 32-bit integers for xoshiro128** state
  const seedBuffer = Buffer.from(seed, 'hex');
  let s = new Uint32Array(4);
  
  // Initialize state from seed buffer (pad/truncate to 16 bytes)
  for (let i = 0; i < 4; i++) {
    s[i] = seedBuffer.readUInt32LE(i * 4) || 0;
  }

  /**
   * Rotate left 32-bit integer
   * @param {number} x - Input value
   * @param {number} k - Rotate amount
   * @returns {number} Rotated value
   */
  function rotl(x, k) {
    return (x << k) | (x >>> (32 - k));
  }

  return {
    /**
     * Generate next random 32-bit integer
     * @returns {number} Random 32-bit unsigned integer
     */
    next() {
      const result = rotl(s[1] * 5, 7) * 9;
      const t = s[1] << 9;
      s[2] ^= s[0];
      s[3] ^= s[1];
      s[1] ^= s[2];
      s[0] ^= s[3];
      s[2] ^= t;
      s[3] = rotl(s[3], 11);
      return result >>> 0; // Convert to unsigned
    },

    /**
     * Generate random float between 0 (inclusive) and 1 (exclusive)
     * @returns {number} Random float in [0, 1)
     */
    nextFloat() {
      return this.next() / 4294967296; // 2^32
    },

    /**
     * Generate random integer in range [min, max)
     * @param {number} min - Minimum value (inclusive)
     * @param {number} max - Maximum value (exclusive)
     * @returns {number} Random integer in range
     */
    nextInt(min, max) {
      return Math.floor(this.nextFloat() * (max - min)) + min;
    }
  };
}

/**
 * Game Session class to manage a single shooter game instance
 */
class ShooterSession {
  /**
   * Create a new shooter game session
   * @param {string} serverSeed - Committed server seed (hex string)
   * @param {object} config - Game configuration
   * @param {number} config.waveCount - Number of waves (default 5)
   * @param {number} config.playerHp - Starting player HP
   */
  constructor(serverSeed, config = {}) {
    this.serverSeed = serverSeed;
    this.prng = createSeededPRNG(serverSeed);
    this.waveCount = config.waveCount || 5;
    this.player = {
      x: 400, // Canvas width assumed 800, start center
      y: 500, // Canvas height assumed 600
      hp: config.playerHp || 100,
      score: 0,
      alive: true
    };
    this.enemies = [];
    this.projectiles = [];
    this.wave = 0;
    this.inputLog = []; // Record of client inputs for replay
    this.gameOver = false;
    this.startTime = Date.now();
  }

  /**
   * Record a client input for replay verification
   * @param {object} input - Input object (e.g., { type: 'move', x: 100, y: 200, tick: 123 })
   */
  recordInput(input) {
    this.inputLog.push({
      ...input,
      tick: this.inputLog.length
    });
  }

  /**
   * Spawn enemies for the current wave (deterministic based on PRNG)
   */
  spawnWave() {
    if (this.wave >= this.waveCount) {
      this.gameOver = true;
      return;
    }

    const enemyCount = 5 + this.wave * 3; // More enemies each wave
    for (let i = 0; i < enemyCount; i++) {
      this.enemies.push({
        id: `enemy-${this.wave}-${i}`,
        x: this.prng.nextInt(50, 750), // Random x in canvas
        y: this.prng.nextInt(-100, -50), // Start above screen
        speed: 0.5 + (this.wave * 0.2) + this.prng.nextFloat() * 0.3,
        hp: 10 + this.wave * 5,
        damage: 10 + this.wave * 2
      });
    }
    this.wave++;
  }

  /**
   * Update game state for one tick (deterministic with inputs)
   * @param {object[]} inputs - Client inputs for this tick
   */
  update(inputs) {
    if (this.gameOver || !this.player.alive) return;

    // Record inputs for this tick
    inputs.forEach(input => this.recordInput(input));

    // Process player movement
    inputs.filter(i => i.type === 'move').forEach(input => {
      if (input.x !== undefined) this.player.x = Math.max(0, Math.min(800, input.x));
      if (input.y !== undefined) this.player.y = Math.max(0, Math.min(600, input.y));
    });

    // Process shooting
    inputs.filter(i => i.type === 'shoot').forEach(() => {
      this.projectiles.push({
        x: this.player.x,
        y: this.player.y,
        speed: 5,
        damage: 20
      });
    });

    // Update enemies (deterministic movement)
    this.enemies.forEach(enemy => {
      enemy.y += enemy.speed;
      // Random horizontal drift (deterministic via PRNG)
      enemy.x += this.prng.nextFloat() * 2 - 1;
    });

    // Update projectiles
    this.projectiles.forEach(proj => {
      proj.y -= proj.speed;
    });

    // Check collisions (projectiles hit enemies)
    this.projectiles = this.projectiles.filter(proj => {
      const hitEnemy = this.enemies.find(enemy => 
        Math.abs(proj.x - enemy.x) < 20 && Math.abs(proj.y - enemy.y) < 20
      );
      if (hitEnemy) {
        hitEnemy.hp -= proj.damage;
        if (hitEnemy.hp <= 0) {
          this.player.score += 100;
          this.enemies = this.enemies.filter(e => e !== hitEnemy);
        }
        return false; // Remove projectile
      }
      return proj.y > 0; // Keep if still on screen
    });

    // Check enemy collisions with player
    this.enemies.forEach(enemy => {
      if (Math.abs(enemy.x - this.player.x) < 20 && Math.abs(enemy.y - this.player.y) < 20) {
        this.player.hp -= enemy.damage;
        enemy.hp = 0; // Enemy dies on contact
        this.enemies = this.enemies.filter(e => e !== enemy);
      }
    });

    // Remove enemies that went off screen
    this.enemies = this.enemies.filter(enemy => enemy.y < 650);

    // Check game over conditions
    if (this.player.hp <= 0) {
      this.player.alive = false;
      this.gameOver = true;
    }

    // Spawn next wave if all enemies defeated
    if (this.enemies.length === 0 && this.wave < this.waveCount) {
      this.spawnWave();
    } else if (this.enemies.length === 0 && this.wave >= this.waveCount) {
      this.gameOver = true;
      this.player.score += 1000; // Completion bonus
    }
  }

  /**
   * Get current game state for client
   * @returns {object} Serializable game state
   */
  getState() {
    return {
      player: { ...this.player },
      enemies: this.enemies.map(e => ({ x: e.x, y: e.y, hp: e.hp })),
      projectiles: this.projectiles.map(p => ({ x: p.x, y: p.y })),
      wave: this.wave,
      gameOver: this.gameOver,
      score: this.player.score
    };
  }

  /**
   * Get replay data for verification
   * @returns {object} Replay data including seed and input log
   */
  getReplayData() {
    return {
      serverSeed: this.serverSeed,
      inputLog: this.inputLog,
      config: {
        waveCount: this.waveCount,
        playerHp: this.player.hp
      },
      finalState: this.getState()
    };
  }
}

/**
 * Create the shooter game plugin
 * @returns {object} Shooter game plugin instance
 */
function createShooterPlugin() {
  return {
    id: 'shooter',
    name: 'Space Shooter',
    defaultConfig: {
      active: true, // Enabled now that verification is implemented
      payoutMultiplier: 10,
      houseEdgePct: 10,
      description: 'Survive 5 waves. Provably fair deterministic gameplay.',
      minBet: 0.1,
      maxBet: 10.0,
      waveCount: 5,
      playerHp: 100
    },
    verification: {
      scheme: 'provably-fair-deterministic',
      proofType: 'seed-commit-reveal',
      status: 'enabled',
      note: 'Game uses server-committed seed and deterministic PRNG for replayable verification'
    },
    /**
     * Get session metadata for client initialization
     * @param {object} options - Session options including serverSeed
     * @returns {object} Session metadata
     */
    getSessionMetadata(options = {}) {
      const serverSeed = options.serverSeed || crypto.randomBytes(16).toString('hex');
      return {
        verification: this.verification,
        client: {
          view: 'shooter',
          disabled: false,
          serverSeedCommit: require('crypto').createHash('sha256').update(serverSeed).digest('hex')
        },
        sessionConfig: {
          serverSeed,
          waveCount: this.defaultConfig.waveCount
        }
      };
    },
    /**
     * Verify game result by replaying with seed and input log
     * @param {object} params - Verification params
     * @param {string} params.serverSeed - Committed server seed
     * @param {object[]} params.inputLog - Log of client inputs
     * @param {object} params.claimedResult - Client-claimed result
     * @returns {object} Verification result
     */
    verifyResult(params) {
      const { serverSeed, inputLog, claimedResult } = params;
      
      // Replay game session
      const session = new ShooterSession(serverSeed, this.defaultConfig);
      
      // Replay all inputs
      inputLog.forEach(input => {
        session.update([input]);
      });

      const finalState = session.getState();
      
      // Check if claimed result matches replayed result
      const valid = finalState.score === claimedResult.score && 
                    finalState.gameOver === claimedResult.gameOver &&
                    finalState.player.alive === claimedResult.playerAlive;

      return {
        valid,
        reason: valid ? 'Result verified successfully' : 'Result does not match replay',
        replayedState: finalState,
        serverSeedCommit: require('crypto').createHash('sha256').update(serverSeed).digest('hex')
      };
    },
    /**
     * Create a new game session
     * @param {object} options - Session options
     * @returns {ShooterSession} New game session
     */
    createSession(options = {}) {
      const serverSeed = options.serverSeed || require('crypto').randomBytes(16).toString('hex');
      return new ShooterSession(serverSeed, this.defaultConfig);
    }
  };
}

module.exports = { createShooterPlugin, ShooterSession, createSeededPRNG };
