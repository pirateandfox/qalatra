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
`aada33e2-e5c5-4cf8-9ad1-c0ca22ccb0d4`. The latest existing successful production iOS build is
version 0.2.0, build 9, created June 24, 2026 (EAS build
`faab0a87-7f0c-4b23-9c15-6c3b71454c9f`). Builds 8 and 6 also completed successfully for store
distribution. This confirms EAS cloud builds were used; App Store submission history has not yet
been inspected. Local iOS bundle export succeeded. Production deployment and the replacement
build/upload remain pending.

A fresh TestFlight binary is required for an expired beta; an OTA update or account comp does not
renew Apple's 90-day build lifetime. Login-only companion-app review eligibility still depends on
Apple's review of the actual app and its service.
