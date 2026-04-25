# Changelog

All notable changes to the NOM-GAMEZ project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.2.0] - 2026-04-25

### Added
- **Games:** Coinflip game (50/50 heads/tails, provably fair)
- **Games:** Roulette game (European style, multiple bet types)
- **Games:** Crash game (multiplier-based, cash out before crash)
- **AI-Native:** Self-monitoring endpoint (`GET /admin/ai/status`) with LLM-optimized output
- **AI-Native:** Natural language command parser (`POST /admin/ai/command`)
- **AI-Native:** Model-agnostic AI integration (OpenRouter, OpenAI, local LLMs)
- **AI-Native:** Self-healing monitor (`self-healing.js`) for autonomous recovery
- **AI-Native:** Rule-based fallback for command parsing when AI unavailable
- **Documentation:** AI-NATIVE.md (AI architecture and vision)
- **Documentation:** SELF-CONTROL.md (self-management capabilities)
- **Infrastructure:** Enhanced Docker healthchecks using `/ready` endpoint
- **Config:** AI configuration section in `config.js`

### Changed
- **README:** Updated with new games and AI-native features
- **Docker:** Healthcheck now uses `/ready` endpoint for comprehensive checks
- **Server:** Integrated self-healer start/stop with server lifecycle

### Security
- Admin token required for AI command endpoint
- Command confidence threshold for AI-parsed commands
- Self-healing actions logged for audit

## [2.1.0] - 2026-04-25

### Added
- **Security:** Add sensitive files to .gitignore (`.env`, `node_modules`, build outputs)
- **Shooter Game:** Implement provably fair deterministic gameplay with seeded PRNG (xoshiro128**)
- **Shooter Game:** Add replayable verification system with seed commitment
- **Markets:** Atomic market settlement with rollback on failure
- **Free Play:** IP/address rate limits (2 per IP per day)
- **Infrastructure:** Dockerfile + docker-compose.yml for one-command startup
- **CI/CD:** GitHub Actions workflow for tests, linting, Docker build/push
- **Frontend:** Modern React + Vite framework (migrated from single HTML)
- **Frontend:** Wallet integration components (Zenon + BTC)
- **Frontend:** Responsive design for mobile/desktop
- **Identity:** Update IDENTITY.md with NOM persona
- **Documentation:** Comprehensive README.md with setup instructions
- **Documentation:** JSDoc comments for all new/modified code

### Changed
- **Markets:** Enable `ENABLE_UNSAFE_MARKETS` (atomic settlement now implemented)
- **Free Play:** Enable `ENABLE_UNSAFE_FREEPLAY` (rate limits now implemented)
- **Shooter Game:** Enabled by default (was disabled due to missing verification)
- **Config:** Add `enableUnsafeMarkets` and `enableUnsafeFreeplay` flags
- **Frontend:** Migrated from single HTML to React components with routing

### Fixed
- **Smoke Tests:** Unskip smoke tests, start server inline
- **Markets:** Proper payout calculation with proportional winning shares
- **Free Play:** Deterministic seeded random for auditable outcomes

### Security
- Prevent secret exposure via .gitignore
- Atomic market settlement prevents partial payout failures
- Rate limits prevent free play abuse

## [2.0.0] - 2023-11-15

### Added
- Initial release of NOM-GAMEZ platform
- Dice and Slots games
- Prediction market system
- Zenon network integration
- Basic free play system
- BTC deposit support

## [1.0.0] - 2023-05-01

### Added
- Project initialization
- Basic gaming framework
