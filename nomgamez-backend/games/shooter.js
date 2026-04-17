function createShooterPlugin() {
  return {
    id: 'shooter',
    name: 'Space Shooter',
    defaultConfig: {
      active: false,
      payoutMultiplier: 10,
      houseEdgePct: 10,
      description: 'Survive 5 waves. Skill-based. Verification rebuild in progress.',
      minBet: 0.1,
      maxBet: 10.0,
    },
    verification: {
      scheme: 'replay-required',
      proofType: 'replay-log',
      status: 'disabled',
      note: 'Shooter payouts are disabled until replayable server-side verification is implemented',
    },
    getSessionMetadata() {
      return {
        verification: this.verification,
        client: {
          view: 'shooter',
          disabled: true,
        },
      };
    },
    verifyResult() {
      return {
        valid: false,
        reason: 'Shooter payouts are disabled until replayable server-side verification is implemented',
      };
    },
  };
}

module.exports = { createShooterPlugin };
