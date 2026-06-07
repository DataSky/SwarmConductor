# Changelog

All notable changes to Swarm Conductor are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/);
versions correspond to git tags and Homebrew releases.

## [Unreleased] — stability hardening

Targeted reliability work (no architectural rewrite). In progress:

- **security**: removed hard-coded DMXAPI key from `src/cli/ai-planner.ts`; the
  key is now read from `DMXAPI_KEY` (env / `.env`), with a fail-loud check.
  Added `.env.example` and git-ignored `.env`. **The previously committed key
  is exposed in public git history and must be rotated.**
- **docs**: aligned `package.json` version (was stale at `0.1.0`) with the
  released tag `0.2.7`; introduced this changelog.

Planned (see task list): subprocess lifecycle hardening, file-lock TTL task
recovery, partial-spawn degradation (`allSettled`), WebSocket dead-connection
reaping, git merge-conflict approval gate, dead-code removal (`memory/bus.ts`),
centralized timeout config, and tests for the above.

## [0.2.7]

- fix(P1): count and log malformed SSE lines instead of silently skipping
- fix(P1): persist CrashRecovery restart counts to SQLite

## [0.2.6]

- ci: expand test suite in release workflow
- fix+test: rewrite `detectDeadlock` with DFS 3-color marking + test coverage
- fix: TaskDetail sticks to viewport bottom; full-width bottom bar layout
- bench: scheduler latency micro-benchmark; remove stale `schedulerTickMs`

## [0.2.5]

- perf+refactor: event-driven scheduler; retire legacy `ui.html`

## [0.2.4]

- refactor: split `standalone.ts` into focused handlers (phase 3)
- feat: full `ui.html` → React component migration (phase 2)
- feat: Vite + React web-ui scaffold, mono mode (phase 1)

## [0.2.3] and earlier

- docs: serve/start commands + `--web` flag in README
- fix: `run_meta` schema migration (add `conductor_dir` column)
- fix: Start Run button unresponsive when WebSocket disconnected
- fix: AI planner — parallelism, context, noise, observability
- feat: warm pool — pre-warm agents at serve startup to kill cold-start latency
- feat: history replay, stale-run reconcile, port pool, replay UI

[Unreleased]: https://github.com/DataSky/SwarmConductor/compare/v0.2.7...HEAD
[0.2.7]: https://github.com/DataSky/SwarmConductor/releases/tag/v0.2.7
[0.2.6]: https://github.com/DataSky/SwarmConductor/releases/tag/v0.2.6
[0.2.5]: https://github.com/DataSky/SwarmConductor/releases/tag/v0.2.5
[0.2.4]: https://github.com/DataSky/SwarmConductor/releases/tag/v0.2.4
