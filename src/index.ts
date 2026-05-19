/**
 * @crawlertoll/hono — Hono middleware for the AI-crawler economy.
 *
 *   import { Hono } from "hono";
 *   import { crawlertoll } from "@crawlertoll/hono";
 *
 *   const app = new Hono();
 *
 *   app.use("*", crawlertoll({
 *     offer: { rail: "x402", priceMicros: 5000, currency: "USD" },
 *     contextLicenseUrl: "https://example.com/.well-known/context-license.json",
 *   }));
 *
 *   app.get("/", (c) => c.text("hello"));
 *
 *   export default app;
 *
 * One package, four runtime targets — Cloudflare Workers, Bun, Deno,
 * Vercel Edge — plus Node and the browser. Hono is fetch-native, so
 * the adapter just translates `Context` ↔ `DecideInput`/`Response` and
 * never touches platform-specific APIs.
 *
 * The middleware:
 *   - Detects AI crawlers via the @crawlertoll/core catalogue
 *   - Verifies Web Bot Auth signatures (Ed25519 / RFC 9421) if present
 *   - Applies RSL 1.0 policy (parsed once, evaluated per-request)
 *   - Returns a 402 with Cloudflare-shape headers + structured offer
 *   - Sets `c.var.crawlertoll` for downstream handlers
 */

import type { Context, MiddlewareHandler } from "hono";

import {
  decide,
  parseRobotsTxt,
  toWebResponse,
  type Build402Options,
  type Decision,
  type DecideInput,
  type PaymentOffer,
  type RslPolicy,
} from "@crawlertoll/core";

/**
 * Type extension for the Hono `c.var` bag so TS-typed app.get handlers
 * get the right shape on `c.var.crawlertoll`.
 *
 * Consumers can pull this in via a generic on `new Hono<{ Variables: CrawlerTollVariables }>()`.
 */
export interface CrawlerTollVariables {
  crawlertoll: Decision;
}

export interface CrawlerTollOptions {
  /** Payment offer to surface when the decision is 402. */
  offer?: PaymentOffer;
  /** Options forwarded to `build402()`. */
  buildOptions?: Omit<Build402Options, "offer">;
  /** Convenience: terms-of-use URL injected as Link rel="terms-of-service". */
  termsUrl?: string;
  /** Convenience: /.well-known/context-license.json URL injected as Link rel="describedby". */
  contextLicenseUrl?: string;
  /**
   * RSL 1.0 policy. Pass either an already-parsed `RslPolicy` or the raw
   * robots.txt body — the middleware parses it once on first request.
   */
  policy?: RslPolicy | string;
  /** Run Web Bot Auth verification when signature headers are present. Default true. */
  verifyAuth?: boolean;
  /** Trust verified bots even when policy would charge them. Default false. */
  trustVerifiedBots?: boolean;
  /**
   * Called for every request after a decision. Receives the decision and
   * the Hono `Context`. Useful for telemetry / dashboards. Errors thrown
   * here are caught and ignored (telemetry must not break the request).
   */
  onDecision?: (decision: Decision, c: Context) => void | Promise<void>;
  /**
   * Hook to short-circuit the decision before any of the standard logic.
   * Return `null` to fall through; return a `Decision` to override.
   */
  decisionOverride?: (c: Context) => Decision | null | Promise<Decision | null>;
}

const DEFAULT_OPTIONS: Required<
  Pick<CrawlerTollOptions, "verifyAuth" | "trustVerifiedBots">
> = {
  verifyAuth: true,
  trustVerifiedBots: false,
};

/**
 * Build the Hono middleware. Returns an `async (c, next) => ...` handler
 * compatible with Hono v4.
 *
 * Generic-typed on the consumer's Hono env so `c.var.crawlertoll` is
 * typed correctly downstream. Default export is parameterised on a
 * minimal env containing the variable; if your app already has its own
 * `Variables` type, intersect ours with yours:
 *
 *     type Env = { Variables: CrawlerTollVariables & { user?: User } };
 *     const app = new Hono<Env>();
 */
export function crawlertoll(
  options: CrawlerTollOptions = {},
): MiddlewareHandler<{ Variables: CrawlerTollVariables }> {
  // Lazily resolve the policy on first request, then memoise. This lets
  // the middleware be wired before policy text is loaded.
  let resolvedPolicy: RslPolicy | undefined;
  let policyResolved = false;
  const resolvePolicy = (): RslPolicy | undefined => {
    if (policyResolved) return resolvedPolicy;
    policyResolved = true;
    if (typeof options.policy === "string") {
      const { policy } = parseRobotsTxt(options.policy);
      resolvedPolicy = policy;
    } else if (options.policy) {
      resolvedPolicy = options.policy;
    }
    return resolvedPolicy;
  };

  const cfg = { ...DEFAULT_OPTIONS, ...options };

  return async (c, next) => {
    let decision: Decision;
    try {
      decision = await runDecision(c, cfg, resolvePolicy);
    } catch (err) {
      // Decision errors propagate as a 500 — same as Express's next(err).
      // Hono's app.onError() can intercept this.
      throw err;
    }

    c.set("crawlertoll", decision);

    // Best-effort telemetry.
    if (options.onDecision) {
      Promise.resolve()
        .then(() => options.onDecision!(decision, c))
        .catch(() => {
          /* swallow */
        });
    }

    if (decision.action === "allow") {
      await next();
      return;
    }
    if (decision.action === "402" && decision.built) {
      return toWebResponse(decision.built);
    }
    if (decision.action === "block") {
      return c.json(
        {
          error: "forbidden",
          message: "Crawler access denied by site policy.",
          reasons: decision.reasons,
        },
        403,
      );
    }
    // Unknown action — fall through.
    await next();
  };
}

async function runDecision(
  c: Context,
  cfg: CrawlerTollOptions & typeof DEFAULT_OPTIONS,
  resolvePolicy: () => RslPolicy | undefined,
): Promise<Decision> {
  if (cfg.decisionOverride) {
    const override = await cfg.decisionOverride(c);
    if (override) return override;
  }

  const headers = headersFromContext(c);
  const policy = resolvePolicy();

  const buildOptions: Omit<Build402Options, "offer"> = {
    ...(cfg.contextLicenseUrl ? { contextLicenseUrl: cfg.contextLicenseUrl } : {}),
    ...(cfg.termsUrl ? { termsUrl: cfg.termsUrl } : {}),
    ...(cfg.buildOptions ?? {}),
  };

  const { authority, targetUri, path } = parseRequestUrl(c.req.url, headers);

  const input: DecideInput = {
    request: {
      method: c.req.method,
      authority,
      targetUri,
      path,
      headers,
    },
    verifyAuth: cfg.verifyAuth,
    trustVerifiedBots: cfg.trustVerifiedBots,
    ...(policy ? { policy } : {}),
    ...(cfg.offer ? { offer: cfg.offer } : {}),
    ...(Object.keys(buildOptions).length ? { buildOptions } : {}),
  };

  return decide(input);
}

function headersFromContext(c: Context): Record<string, string> {
  const out: Record<string, string> = {};
  // Hono's c.req.raw.headers is a native Headers object; iterate it once.
  c.req.raw.headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function parseRequestUrl(
  rawUrl: string,
  headers: Record<string, string>,
): { authority: string; targetUri: string; path: string } {
  try {
    const u = new URL(rawUrl);
    const authority = headers["host"] ?? u.host;
    const targetUri = u.pathname + (u.search ?? "");
    return { authority, targetUri, path: u.pathname };
  } catch {
    // Hono on some runtimes (older Bun) gives a path-only URL. Cope.
    const path = rawUrl.split("?")[0] ?? "/";
    return {
      authority: headers["host"] ?? "localhost",
      targetUri: rawUrl,
      path,
    };
  }
}

// ─── Type re-exports for consumer ergonomics ───────────────────────

export type {
  Build402Options,
  Built402Response,
  PaymentOffer,
  SettlementRail,
  Decision,
  DecisionAction,
  RslPolicy,
} from "@crawlertoll/core";
