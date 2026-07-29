# Qalatra — Web App, Accounts & Monetization Architecture

Status: **planned, deferred.** Captures the decisions from the monetization
discussion so they're ready when we pick this up. Nothing here is built yet, and
none of it blocks the mobile app (which ships auth-free for now).

Related: [[EXPO_MOBILE_ROADMAP.md]] (the native app), `qalatra.com` repo (the
NestledJS account/billing site).

---

## Monetization model

- **Free, forever:** desktop Electron (open source) + you run your own backend.
- **Paid (~$10/mo):** access to **Qalatra's hosted web app + native mobile apps**.
  You still run your **own** backend — you're paying for the polished web/native
  *interfaces*, not for hosting. Open-core: DIY is free, convenience is paid.
- **Paid (hundreds/mo, later):** managed **backend hosting** as a separate premium
  add-on. Much higher price; out of scope for v1.

Enforcement is honest about the open-source reality: the paywall gates **access to
_Qalatra's_ hosted web app and _Qalatra's_ published App Store / Play apps**, not
the code. Self-hosting the open-source client (desktop or web) stays free — the
same escape hatch as the desktop app. Ordinary users pay for the hosted/published
convenience; the technical crowd self-hosts for free.

---

## The clean separation

```
qalatra.com (NestledJS)   → marketing + accounts + billing
                            + exposes a TOKEN auth + entitlement endpoint
app.qalatra.com           → ui/ deployed as-is (web platform adapter,
                            no local server, + login gate)
native apps               → Expo (mobile), same login endpoint
                            ↑ all three authenticate against the SAME identity
desktop (Electron)        → free, open source, gate OFF

@qalatra/shared
  └── new `account` module: login(), getEntitlement()  → calls qalatra.com
```

- **qalatra.com is the account brain.** Inspected: Nx + pnpm monorepo on NestledJS,
  NestJS + Prisma + **GraphQL** API, web app on **React Router 7 (SSR) + Vite +
  React 19**. It already has `auth.context`, `subscription.context` (~156 lines),
  `upgrade-modal`, and org ownership/emulation — i.e. the accounts + billing system
  is largely built.
- **The login gate is one screen in front of the existing "connect a backend"
  flow.** After login + active entitlement, the user drops into the onboarding we
  already built, which already supports connecting to **many** backends. The login
  doesn't change the app; it precedes it.
- **Whether the gate shows is a build flag**, riding the platform-adapter pattern:

  | Build | `requiresAccountAuth` | Flow |
  |---|---|---|
  | Desktop Electron (free, OSS) | `false` | → connect-a-backend directly |
  | Hosted web (app.qalatra.com) | `true` | login → connect-a-backend |
  | Native mobile (published) | `true` | login → connect-a-backend |

  Same code everywhere; the free desktop build simply skips the gate.

---

## Web app: keep `ui/` separate, do NOT port into qalatra.com

**Decision: host the existing `ui/` as the web app (app.qalatra.com). Do not port
it into qalatra.com, and do not use React Native Web.**

- `ui/` is already a full Vite + React 19 web app (Electron just wraps it). Hosting
  it is near-zero new UI work and gives the rich, desktop-grade browser experience.
- `ui/` already serves the free open-source desktop, so **web = `ui/` is free
  leverage** — one codebase serves desktop *and* web.
- **Porting `ui/` into qalatra.com fails on cross-repo cost, not framework.** The
  frameworks are compatible (same React 19 + Vite; `ui/` would mount as a
  client-only `ssr:false` React Router 7 route). But `ui/` lives in the *qalatra*
  repo (it's the open-source desktop app); pulling it into the *qalatra.com* repo
  means either **forking it** (two copies — destroys the one-codebase design) or
  **cross-repo package publishing** (npm vs pnpm/nx toolchain clash). That ongoing
  tax outweighs the one-time integration.
- **RN Web** would serve the web with the thinner mobile UI and make `ui/`
  desktop-only — more work, worse web, no codebase saved. Rejected.

**Single login without merging:** it needs a shared *identity provider*, not shared
code. qalatra.com already is one (auth + subscriptions). Both the web SPA and the
mobile app call its auth endpoint; for the web, cross-subdomain session via a
cookie on `.qalatra.com` (or an OAuth-style token handoff
`qalatra.com` ↔ `app.qalatra.com`). One account, one login, everywhere.

**The one new thing to build in qalatra.com:** its auth today is session/cookie for
its own SSR site. External clients (the SPA on another subdomain, and mobile) need
it to **issue a token** (JWT/session) via a cross-origin endpoint, plus an
"is this account entitled?" check. Bounded addition on top of existing auth; it's
the same endpoint `@qalatra/shared`'s `account` module calls from web and mobile.

---

## Payments & Apple IAP

- **Web:** charge via Stripe in qalatra.com (Nestled already has billing). No Apple
  involvement.
- **iOS — the gotcha:** a ~$10/mo subscription that unlocks app functionality
  normally must use **In-App Purchase** (15–30%). The **Asana/Slack model** avoids
  it: the app **sells nothing in-app** — no pricing, no "subscribe," just a login to
  an account paid for on the web (Apple treats this as a "multiplatform service",
  guideline 3.1.3). This is a real, widely-used path, but it's a **gray area for
  consumer apps** (Apple is lenient with business/productivity services, stricter
  with consumer ones). Keep the app purchase-UI-free; have IAP as the fallback if a
  reviewer pushes back.
- **Android:** Play has a similar default but is more permissive post-2024; less of
  a blocker than iOS.
- **Unify entitlement server-side:** qalatra.com records "active" whether payment
  came from Stripe (web) or an Apple/Google IAP receipt (mobile). Clients just ask
  "is this account active?" — one entitlement API, many payment sources.

### Sales Portal Catalog V1

The current launch catalog lives in the project planning workspace:

```txt
/Users/justinhandley/IdeaProjects/projects/qalatra/business-plan/sales-portal-catalog-v1.md
```

Implementation rules from that catalog:

- Connect is the hosted web/native access layer.
- Connect has monthly and annual tiered licensed-seat pricing.
- Connect gets a 14-day free trial applied at Checkout/subscription creation with `subscription_data[trial_period_days]=14`.
- Do not create a separate `$0` trial product.
- Cloud Standard Agent Node, DevNode, and DevNode Plus are monthly-only hosted products with no free trial and no self-serve annual price.
- Cloud subscriptions include one admin Connect seat; additional human users require Connect seats.
- Native apps are login-only clients paid through the web account unless Apple/Google force IAP later.
- Use restricted Stripe API keys for catalog setup and checkout testing; do not require full live secret keys.

### RevenueCat
Worth it **only if** we end up doing native IAP — it wraps StoreKit + Play Billing
+ web into one entitlement API and removes the misery of receipt validation. If we
ride the Asana-style login-only model (all money via Stripe on web), there's no IAP
to manage and **RevenueCat is unnecessary**. **Plan:** model `getEntitlement()` as a
swappable provider in `@qalatra/shared` so we can drop RevenueCat in later, behind
the same interface, without touching the app — but keep it off the critical path.

---

## Build order (when we pick this up)
1. qalatra.com: token auth + entitlement endpoint (on top of existing auth/billing).
2. `@qalatra/shared`: `account` module (`login`, `getEntitlement`) + a swappable
   entitlement provider interface.
3. `requiresAccountAuth` capability + a login screen in front of connect-a-backend
   (reused by `ui/` web build and mobile).
4. Host `ui/` as `app.qalatra.com` (web platform adapter: no local server, gate on).
5. Cross-subdomain SSO between qalatra.com and app.qalatra.com.
6. Stripe checkout on web (likely already present in Nestled); IAP only if forced.
