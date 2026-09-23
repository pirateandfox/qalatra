# Hosted web and mobile account release

Implemented 2026-09-22. Deploy the portal API before either client: they now query
`accountEntitlements` at `https://api.qalatra.com/graphql`.

## Access model

One qalatra.com account unlocks the official web/mobile clients when it has an assigned active
Connect or Cloud seat in any current organization membership. Account credentials remain separate
from each Qalatra data backend's URL/token. The free desktop and self-hosted builds are unchanged.

Checks run at boot, every 60 seconds, and on browser focus/native foreground. Revocation/denial
locks access immediately on the next completed check. Transient network/5xx/429 failures preserve
an already-verified session for at most five minutes; this grace is in memory, never carried across
cold starts or accounts. Requests time out after 15 seconds. Expired credentials return to login.

## Complimentary Connect access

In qalatra.com, open Admin → Billing → Subscriptions → Complimentary Connect access. Select the
organization and Connect plan, enter an existing member's primary email and an internal reason,
and grant access. This assigns one free seat, without Stripe or Cloud infrastructure, until revoked.
Repeating the same grant is idempotent. Grants to additional members grow the organization's comp
pool. The caller needs `platform.billing.manage`; each grant/revoke is audited.

The table's Revoke comp action revokes all seats in that Connect comp pool; paid seats are unaffected.
This admin action is pool-wide. A regrant after pool revocation starts with only the newly granted recipient, so old recipients do not regain access silently.

## Web release

1. Deploy qalatra.com with the new API/schema and admin UI. No migration is required.
2. Add `https://app.qalatra.com` to the API service's `ALLOWED_ORIGINS`, retaining existing origins.
   During inspection the value was `https://qalatra.com,https://preview.flightdesk.dev,`.
3. Build the task-client service from `pirateandfox/qalatra`, branch `develop`, repository root,
   Dockerfile `deploy/hosted-web.Dockerfile`. Use healthcheck `/health` and container port 8080
   (or set `PORT`; the nginx template reads it). Attach `app.qalatra.com` and add the returned DNS
   records. This is a separate service from qalatra.com's existing marketing/account `web`.
4. The Docker build runs `npm run build:hosted --prefix ui`. Hosted mode forces account auth on
   even if a desktop build environment has the flag off, and writes `ui/dist-hosted`.
5. Verify an unauthenticated browser sees login, then exercise 2FA, denied/granted seat,
   sign-out, and revocation while open. Qalatra Server already allows bearer requests from
   browser origins; any external proxy in front of a user's backend must also allow them.

The hosted build defaults to the production account API/portal. Custom endpoint configuration,
when needed, is supplied through Vite's `VITE_QALATRA_ACCOUNT_GRAPHQL_URL`,
`VITE_QALATRA_PORTAL_URL`, and `VITE_QALATRA_PRODUCT_KEY` at build time.

Local image validation:

```sh
docker build -f deploy/hosted-web.Dockerfile -t qalatra-hosted .
docker run --rm -p 127.0.0.1:4186:8080 qalatra-hosted
```

## Native release

Mobile sells nothing and has no purchase, registration, or billing-portal links. It presents login,
2FA, access refresh, and sign-out. Native credentials use Expo SecureStore. The previous prefix
contained `:`, which Expo rejects; the corrected key is `qalatra.secure.qalatra.account.token`.

Use the configuration in `mobile/`, not the root `eas.json`:

```sh
cd mobile
npm run typecheck
npx expo export --platform ios --output-dir /tmp/qalatra-mobile-export
eas build --platform ios --profile production
eas submit --platform ios --profile production --id <verified-new-build-id>
```

The production profile auto-increments the remote build number. Do not recreate the Expo project
or change bundle ID to bypass an access error: preserve the existing App Store identity and OTA
project. Validate a signed build on-device before distribution and provide a comp review account
plus an accessible demo backend for App Review.

Expo access was restored on September 23 by signing the local EAS CLI into `pirateandfox`
(`justin@pirateandfox.com`). The verified project is `@pirateandfox/qalatra`, ID
`aada33e2-e5c5-4cf8-9ad1-c0ca22ccb0d4`. The existing App Store app ID is `6782659910`, now pinned
in `mobile/eas.json` for non-interactive submissions. Apple confirmed the prior 0.2.0 (9) beta
had expired.

## September 23 production rollout

- Portal/API deployed with admin Connect comps and `accountEntitlements`. Production CORS
  retains the existing origins and allows `https://app.qalatra.com`.
- Hosted client is live at **https://app.qalatra.com**, Railway service `app`
  (`a2429b81-7fc2-4974-a757-a98b609bb332`) in the qalatra.com production project. The service
  tracks `pirateandfox/qalatra` develop, watching `ui/`, `packages/shared/`, and `deploy/`.
  Its configuration is recorded in the website repository's `.railway/railway.ts`.
- Cloudflare has a DNS-only CNAME to `xryhc4re.up.railway.app` and the required TXT ownership
  record at `_railway-verify.app.qalatra.com`. Railway's MCP domain response omitted the TXT;
  `railway domain status app.qalatra.com --service app --json` exposes `verification.dnsHost`
  and `verification.token`. HTTPS was verified after adding both records.
- Live browser smoke passed: login screen, no JavaScript errors, real API CORS and unauthenticated
  denial, health, SPA fallback, and missing-asset 404. Granted/denied/revoked access and 2FA were
  tested locally with controlled account responses; real account/device validation remains manual.
- iOS **0.3.0 (10)** built successfully: EAS build
  `31cd3a54-0a3e-4698-84db-d28f6e87bfd5`. Submission
  `5c85bd83-3c36-4237-afad-ad41526ca56f` finished successfully. Apple confirmed processing
  `VALID`, internal testing `IN_BETA_TESTING`, and external testing `READY_FOR_BETA_SUBMISSION`.
  External beta review has not been submitted. Check current status with
  `eas submit:status --platform ios --json --non-interactive` from `mobile/`.
- Desktop v1.9.51 release workflow completed successfully on all platforms, including its
  required-asset verification and publication of curated release notes.
- No complimentary access was granted during deployment; grant the intended existing portal
  member through the admin form before testing that account.

A fresh TestFlight binary is required for an expired beta; an OTA update or account comp does not
renew Apple's 90-day build lifetime. Login-only companion-app review eligibility still depends on
Apple's review of the actual app and its service.
