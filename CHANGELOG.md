# Changelog

All notable changes to `@crawlertoll/hono` are documented here.

The package follows [Semantic Versioning](https://semver.org/) and tracks the `@crawlertoll/core` major version.

## [0.1.0] — 2026-05-19

Initial release. Ships alongside `@crawlertoll/core` v0.1.0 and `@crawlertoll/express` v0.1.0.

### Added

- `crawlertoll(options)` Hono middleware factory. Returns an `async (c, next) => ...` handler compatible with Hono v4.
- Decision attached to `c.var.crawlertoll` with the `CrawlerTollVariables` type, intersectable with consumer app Variables.
- Supports inline RSL 1.0 policy via `options.policy: RslPolicy | string` (raw robots.txt is parsed once and cached).
- `onDecision` telemetry hook (best-effort; errors swallowed so telemetry never breaks a request — Cloudflare Workers can wrap in `c.executionCtx.waitUntil`).
- `decisionOverride` hook for whitelisted-internal-service patterns.
- `verifyAuth` (default true) and `trustVerifiedBots` (default false) toggles.
- Same `@crawlertoll/core` engine as `@crawlertoll/express` — decisions, 402 shape, and bot catalogue are byte-identical across adapters.

### Runtime coverage

Single package, four runtime targets verified to work without modification:

- Cloudflare Workers
- Bun
- Deno
- Vercel Edge

Plus Node 20+ and modern browsers.

### Conformance

- 8/8 vitest tests via Hono's `app.request()` synthetic fetch harness.
- Re-uses `@crawlertoll/core`'s 47-test conformance suite indirectly through the decision engine.
