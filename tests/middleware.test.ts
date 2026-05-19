/**
 * Hono adapter end-to-end tests.
 *
 * Hono exposes `app.request()` — a synthetic fetch that runs the full
 * middleware chain in-process. We use it to fire real Request objects
 * and assert on status / headers / body.
 *
 * No platform-specific shims: the same tests would pass under
 * Cloudflare Workers, Bun, Deno, and Vercel Edge.
 */

import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import {
  crawlertoll,
  type CrawlerTollVariables,
} from "../src/index.js";

function makeApp(opts: Parameters<typeof crawlertoll>[0]) {
  const app = new Hono<{ Variables: CrawlerTollVariables }>();
  app.use("*", crawlertoll(opts));
  app.get("/", (c) => c.text("ok"));
  app.get("/articles/:id", (c) => c.text("article"));
  app.get("/public/x", (c) => c.text("public"));
  return app;
}

describe("@crawlertoll/hono", () => {
  it("passes browser requests through", async () => {
    const app = makeApp({
      offer: { rail: "x402", priceMicros: 5000, currency: "USD" },
    });
    const res = await app.request("http://test.example/", {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2) AppleWebKit/605.1.15",
      },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("returns 402 with crawler-price header to a known bot", async () => {
    const app = makeApp({
      offer: { rail: "x402", priceMicros: 5000, currency: "USD" },
      contextLicenseUrl: "https://example.com/.well-known/context-license.json",
      termsUrl: "https://example.com/ai-terms",
    });
    const res = await app.request("http://test.example/articles/1", {
      headers: { "user-agent": "GPTBot/1.2" },
    });
    expect(res.status).toBe(402);
    expect(res.headers.get("crawler-price")).toBe("5000 micros USD");
    expect(res.headers.get("crawler-price-rail")).toBe("x402");
    expect(res.headers.get("link")).toContain('rel="describedby"');
    expect(res.headers.get("link")).toContain('rel="terms-of-service"');

    const body = (await res.json()) as {
      error: string;
      offer: { rail: string; priceMicros: number };
    };
    expect(body.error).toBe("payment_required");
    expect(body.offer.priceMicros).toBe(5000);
  });

  it("allows bots when no offer is configured (default-allow)", async () => {
    const app = makeApp({});
    const res = await app.request("http://test.example/", {
      headers: { "user-agent": "ClaudeBot/2.0" },
    });
    expect(res.status).toBe(200);
  });

  it("populates c.var.crawlertoll for downstream handlers", async () => {
    const captured: Array<unknown> = [];
    const app = new Hono<{ Variables: CrawlerTollVariables }>();
    app.use(
      "*",
      crawlertoll({
        offer: { rail: "x402", priceMicros: 5000, currency: "USD" },
      }),
    );
    app.get("/", (c) => {
      captured.push(c.var.crawlertoll);
      return c.text("ok");
    });
    await app.request("http://test.example/", {
      headers: {
        "user-agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
      },
    });
    expect(captured).toHaveLength(1);
    const decision = captured[0] as {
      action: string;
      bot: { isBot: boolean };
    };
    expect(decision.action).toBe("allow");
    expect(decision.bot.isBot).toBe(false);
  });

  it("respects RSL policy passed inline as robots.txt text", async () => {
    const policy = `
User-agent: GPTBot
Disallow: /
Allow: /public

User-agent: *
Disallow:
`;
    const app = makeApp({
      policy,
      offer: { rail: "x402", priceMicros: 5000, currency: "USD" },
    });

    const blocked = await app.request(
      "http://test.example/articles/1",
      { headers: { "user-agent": "GPTBot/1.2" } },
    );
    // Disallow:/ with no Compensation → block (403)
    expect(blocked.status).toBe(403);
    const blockedBody = (await blocked.json()) as { error: string };
    expect(blockedBody.error).toBe("forbidden");

    const allowed = await app.request("http://test.example/public/x", {
      headers: { "user-agent": "GPTBot/1.2" },
    });
    expect(allowed.status).toBe(200);
  });

  it("charges (402) when RSL declares per-crawl compensation", async () => {
    const policy = `
User-agent: GPTBot
Disallow: /
Compensation: per-crawl 5000 micros USD
`;
    const app = makeApp({
      policy,
      offer: { rail: "x402", priceMicros: 5000, currency: "USD" },
    });
    const res = await app.request("http://test.example/articles/1", {
      headers: { "user-agent": "GPTBot/1.2" },
    });
    expect(res.status).toBe(402);
  });

  it("calls onDecision telemetry hook for every request", async () => {
    const seen: string[] = [];
    const app = new Hono<{ Variables: CrawlerTollVariables }>();
    app.use(
      "*",
      crawlertoll({
        offer: { rail: "x402", priceMicros: 5000, currency: "USD" },
        onDecision: (decision) => {
          seen.push(decision.action);
        },
      }),
    );
    app.get("/", (c) => c.text("ok"));
    await app.request("http://test.example/", {
      headers: { "user-agent": "GPTBot/1.2" },
    });
    await app.request("http://test.example/", {
      headers: {
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2)",
      },
    });
    // Give the best-effort hook a tick to settle.
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual(["402", "allow"]);
  });

  it("decisionOverride can short-circuit the decision", async () => {
    const app = new Hono<{ Variables: CrawlerTollVariables }>();
    app.use(
      "*",
      crawlertoll({
        offer: { rail: "x402", priceMicros: 5000, currency: "USD" },
        decisionOverride: () => ({
          action: "allow",
          bot: {
            isBot: true,
            entry: null,
            userAgent: "test",
            hasSignatureHeaders: false,
            signatureAgent: null,
            reasons: Object.freeze(["override"]),
          },
          reasons: Object.freeze(["override"]),
        }),
      }),
    );
    app.get("/", (c) => c.text("ok"));
    const res = await app.request("http://test.example/", {
      headers: { "user-agent": "GPTBot/1.2" },
    });
    // Without override this would be 402; with override it's 200.
    expect(res.status).toBe(200);
  });
});
