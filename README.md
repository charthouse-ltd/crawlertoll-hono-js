# @crawlertoll/hono

Hono middleware for the AI-crawler economy. One line wires bot detection, Web Bot Auth verification, RSL 1.0 policy enforcement, and HTTP 402 issuance into any Hono app — and the same package runs unmodified on **Cloudflare Workers, Bun, Deno, Vercel Edge**, Node, and the browser.

- **License**: Apache-2.0
- **Hono**: 4.x (peer dependency)
- **Runtimes**: anything Hono supports
- **Core**: [`@crawlertoll/core`](https://www.npmjs.com/package/@crawlertoll/core) — all the standards work happens there; this package is the thin Hono bridge.

[![npm](https://img.shields.io/npm/v/%40crawlertoll%2Fhono.svg)](https://www.npmjs.com/package/@crawlertoll/hono)
[![license](https://img.shields.io/npm/l/%40crawlertoll%2Fhono.svg)](./LICENSE)

---

## Install

```bash
npm install @crawlertoll/hono @crawlertoll/core hono
```

---

## Sixty seconds

```ts
import { Hono } from "hono";
import { crawlertoll } from "@crawlertoll/hono";

const app = new Hono();

app.use("*", crawlertoll({
  offer: {
    rail: "x402",
    priceMicros: 5000,
    currency: "USD",
  },
  contextLicenseUrl: "https://example.com/.well-known/context-license.json",
  termsUrl: "https://example.com/ai-terms",
}));

app.get("/", (c) => c.text("hello"));

export default app;
```

Any AI crawler hitting your endpoints gets a 402 with Cloudflare-shape `Crawler-Price` headers and a JSON payment offer. Browsers pass through. Works identically across Cloudflare Workers, Bun, Deno, Vercel Edge, Node, and the browser.

---

## Cloudflare Workers

```ts
// wrangler.toml: name = "my-worker", main = "src/index.ts"

import { Hono } from "hono";
import { crawlertoll } from "@crawlertoll/hono";

const app = new Hono();

app.use("*", crawlertoll({
  policy: /* fetched from KV, R2, or inlined */ undefined,
  offer: { rail: "cloudflare-ppc", priceMicros: 5000, currency: "USD" },
}));

app.get("/articles/:id", (c) => {
  // Your handler. c.var.crawlertoll is typed and populated.
  return c.json({ id: c.req.param("id") });
});

export default app;
```

`wrangler deploy` and you're done. The middleware ships in your Worker bundle (~50 KB after tree-shaking).

## Bun

```ts
import { Hono } from "hono";
import { crawlertoll } from "@crawlertoll/hono";

const app = new Hono();
app.use("*", crawlertoll({ /* ... */ }));
app.get("/", (c) => c.text("hello"));

Bun.serve({ port: 3000, fetch: app.fetch });
```

## Deno

```ts
import { Hono } from "npm:hono";
import { crawlertoll } from "npm:@crawlertoll/hono";

const app = new Hono();
app.use("*", crawlertoll({ /* ... */ }));
app.get("/", (c) => c.text("hello"));

Deno.serve(app.fetch);
```

## Vercel Edge

```ts
// app/api/[[...slug]]/route.ts

import { Hono } from "hono";
import { handle } from "hono/vercel";
import { crawlertoll } from "@crawlertoll/hono";

export const runtime = "edge";

const app = new Hono().basePath("/api");
app.use("*", crawlertoll({ /* ... */ }));
app.get("/articles/:id", (c) => c.json({ id: c.req.param("id") }));

export const GET = handle(app);
```

---

## With an RSL 1.0 policy

The middleware accepts your robots.txt body directly. Policy is parsed once on first request, then cached.

```ts
import { Hono } from "hono";
import { crawlertoll } from "@crawlertoll/hono";

const app = new Hono();

const robotsTxt = `
User-agent: GPTBot
User-agent: ClaudeBot
Disallow: /
Allow: /public
License: https://example.com/ai-license
Permits: ai-search, rag
Prohibits: ai-training
Compensation: per-crawl 5000 micros USD
Standard: RSL/1.0

User-agent: *
Disallow:
`;

app.use("*", crawlertoll({
  policy: robotsTxt,
  offer: {
    rail: "x402",
    priceMicros: 5000,
    currency: "USD",
    paymentUrl: "https://pay.example.com/abc",
  },
}));
```

Behaviour:

- GPTBot or ClaudeBot hits `/articles` → **402** with the payment offer (Disallow + Compensation = charge)
- GPTBot hits `/public/anything` → **200** (Allow override)
- Random browser → **200** (`*` catch-all is `Disallow:`)

---

## Per-request decision API — typed `c.var.crawlertoll`

The middleware attaches the structured decision to `c.var.crawlertoll`. To get the type right, parameterise your Hono app:

```ts
import { Hono } from "hono";
import { crawlertoll, type CrawlerTollVariables } from "@crawlertoll/hono";

const app = new Hono<{ Variables: CrawlerTollVariables }>();

app.use("*", crawlertoll({ /* ... */ }));

app.get("/articles/:id", (c) => {
  const decision = c.var.crawlertoll;
  if (decision.bot.isBot) {
    console.log("bot", decision.bot.entry?.name, "→", decision.action);
  }
  return c.json({ id: c.req.param("id") });
});
```

If you already have your own `Variables` type, intersect ours with yours:

```ts
type Env = {
  Variables: CrawlerTollVariables & { user?: User; requestId: string };
};
const app = new Hono<Env>();
```

---

## All options

```ts
crawlertoll({
  /** Payment offer surfaced when the decision is 402. */
  offer?: PaymentOffer,

  /** RSL 1.0 policy. Pass parsed `RslPolicy` or raw robots.txt text. */
  policy?: RslPolicy | string,

  /** Convenience: terms-of-use URL injected as Link rel="terms-of-service". */
  termsUrl?: string,

  /** Convenience: /.well-known/context-license.json URL injected as Link rel="describedby". */
  contextLicenseUrl?: string,

  /** Run Web Bot Auth verification when signature headers are present. Default true. */
  verifyAuth?: boolean,

  /** Trust verified bots even when policy would charge them. Default false. */
  trustVerifiedBots?: boolean,

  /** Called after every decision. Telemetry hook. */
  onDecision?: (decision, c) => void | Promise<void>,

  /** Short-circuit the decision pipeline. */
  decisionOverride?: (c) => Decision | null | Promise<Decision | null>,

  /** Pass-through options to build402(). */
  buildOptions?: Omit<Build402Options, "offer">,
})
```

---

## Telemetry hook

`onDecision` runs on every request after the decision is reached. Best-effort: errors thrown in the hook are caught and swallowed (telemetry must not break the request).

```ts
app.use("*", crawlertoll({
  offer: { rail: "x402", priceMicros: 5000, currency: "USD" },
  onDecision: (decision, c) => {
    // On Cloudflare Workers:
    c.executionCtx.waitUntil(
      metrics.increment("crawler.decision", {
        action: decision.action,
        operator: decision.bot.entry?.operator ?? "unknown",
        verified: decision.authVerified?.valid ?? false,
        path: new URL(c.req.url).pathname,
      }),
    );
  },
}));
```

---

## Conformance

8 `app.request()` end-to-end tests cover:

- Browser request passes through
- Known bot → 402 with correct headers + body
- Bot allow-list (no offer configured) → 200
- `c.var.crawlertoll` populated and typed on every request
- RSL policy: blocked → 403, charge model → 402, Allow override → 200
- `onDecision` telemetry hook called for every request
- `decisionOverride` short-circuits the pipeline

The tests use Hono's synthetic `app.request()` — the same harness Hono itself uses for its test suite, which means the tests would pass identically under Cloudflare Workers, Bun, Deno, and Vercel Edge.

Run them:

```bash
git clone https://github.com/charthouse-ltd/crawlertoll-hono-js
cd crawlertoll-hono-js
npm install
npm test
```

---

## Compatible frameworks

This package is the Hono adapter. Other framework adapters use the same `@crawlertoll/core` engine — semantics are identical, only the request/response shim differs.

- `@crawlertoll/express` (Node, Express 4 + 5)
- `@crawlertoll/hono` (this package — CF Workers, Bun, Deno, Vercel Edge, Node, browser)
- `@crawlertoll/fastify` (Day 30)
- `@crawlertoll/next` (Day 30 — Next.js `middleware.ts`)

If your framework isn't listed, use `@crawlertoll/core`'s `decide()` directly — it's framework-agnostic.

---

## License

[Apache-2.0](./LICENSE). All specs implemented are open standards under their own licenses (HTTP 402, IETF draft-meunier-web-bot-auth, RSL 1.0, x402).

## Trademark

CrawlerToll™ is a trademark of Charthouse Ltd.
