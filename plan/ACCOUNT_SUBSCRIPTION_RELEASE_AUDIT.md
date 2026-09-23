# Account/subscription release audit — 2026-09-22

Investigation only: no production configuration, subscriptions, or app releases changed.

## Conclusion

Use qalatra.com's existing identity and billing API. Login and entitlement checks already exist
in both client sources. This is completion and deployment work, not a new authentication system.
The documented hosted app URL is `https://app.qalatra.com`; it did not resolve during this audit.
No alternate hosted task-client deployment was found in the inspected repositories or the
qalatra.com Railway project. The Railway `web` service is the marketing/account portal, not `ui/`.

## Evidence and validation limits

- Client implementation was committed in `304c5ee` (release 1.9.34).
- Portal checkout HEAD and latest successful Railway API deployment both identify
  `c224356a018a8cbbe1af2c6594adcb6bf8ff66b5` (deployment created September 21).
- Public `https://api.qalatra.com/graphql` accepts the `entitlements { productKey active hasSeat }`
  query shape and returns `UNAUTHENTICATED` without a token, as expected.
- OPTIONS preflight with Origin `https://qalatra.com` returns 204 and the appropriate CORS headers.
  The same request with Origin `https://app.qalatra.com` returns 500 without CORS headers.
  The API's origin callback throws on origins outside its allowlist; add the hosted-app origin
  and repeat the real browser check before launch.
- `npm run test:account` passes. It tests the shared client's 2FA, credential storage, included
  Cloud seat, and clearing revoked credentials with mocked responses, not real checkout/login.
- No real payment, authenticated entitlement, device build, or TestFlight history was exercised.
  The installed beta's contents and exact expiration date remain unverified.

## Existing flow

1. qalatra.com handles account registration, login, organizations, Stripe Checkout, and billing.
2. Its webhook service reconciles Stripe subscriptions and quantities into PostgreSQL and assigns
   a purchaser seat. Checkout uses the mapped Plan's trial period; Connect's catalog intent is
   a 14-day trial with monthly/annual seat billing.
3. `packages/shared/src/account.ts` logs in at `https://api.qalatra.com/graphql`, completes 2FA
   when necessary, saves the returned bearer token, and asks for server-computed entitlements.
4. Access requires an active Connect entitlement AND an assigned seat; an active assigned Cloud
   seat also unlocks the clients. Native credentials use Expo SecureStore.
5. After account access passes, the existing backend URL/token connection flow runs. Account
   credentials and backend credentials remain separate. The free Electron client remains ungated.

The portal resolver computes access from ACTIVE/TRIALING status, with a three-day PAST_DUE grace
when a period end exists. It currently treats PAST_DUE without a period end as active indefinitely;
that edge case should get an explicit bounded policy. Entitlements are scoped to the user's
active organization, not all their organizations. Older planning sections describe a different
design; the resolver is authoritative.

## Required changes

### qalatra.com: complimentary Connect seats

`libs/api/custom/src/lib/plugins/billing/complimentary-subscription.service.ts` and
`apps/web/app/routes/admin/billing/subscriptions.tsx` currently grant/revoke **Cloud servers only**.
The grant path provisions fleet capacity; do not use it merely to give someone mobile access.

Extend the admin billing flow with a Connect grant: select an account/organization, seat count,
recipient(s), and internal reason. Create an ACTIVE subscription with billing source
COMPLIMENTARY and assign its seats. Preserve platform permission checks and audit logging.
Support revocation and optionally an explicit expiration date; a permanent founder comp can
remain active until revoked. Paid and comp pools already coexist in the schema and entitlement
aggregation, so a fake Stripe purchase or 100% coupon is unnecessary. Avoid an email-based bypass
in either client. Connect grants must never invoke Cloud provisioning/teardown.

### qalatra: finish the account gate lifecycle

- `ui/src/components/AccountGate.tsx` and `mobile/App.tsx`: revalidate on foreground/focus and
  periodically during use. Currently checks happen at boot/login/retry, allowing an already-open
  client to retain access after a seat or subscription is revoked. Define a bounded outage grace
  separately from a definitive denial; currently cold startup fails closed when the API is down.
- `mobile/App.tsx`: instance changes call `evaluate()` directly, which selects onboarding/main
  without checking account state. Keep license state authoritative across backend changes.
- `packages/shared/src/account.ts`: find an active assigned Connect entitlement across all
  matching entries. It currently examines only the first matching product, while the API groups
  by plan; another valid Connect plan could be overlooked.
- Account UX: add an access-refresh action after seat assignment/payment, normal sign-out and
  account management, and a way to select an eligible organization (or a dedicated cross-org
  access query). Existing account clients do not switch organizations.
- Exercise expired/revoked tokens, 2FA, missing seats, comp/revoked comp, cancellations, failed
  payments, and API outages. Existing shared-client checks do not test either gate's lifecycle.

### Hosted web deployment

Deploy `ui/` at `app.qalatra.com`, configure DNS/TLS and SPA fallback, and build with:

```text
VITE_QALATRA_ACCOUNT_AUTH=true
VITE_QALATRA_ACCOUNT_GRAPHQL_URL=https://api.qalatra.com/graphql
VITE_QALATRA_PORTAL_URL=https://qalatra.com
VITE_QALATRA_PRODUCT_KEY=connect
```

The gate is OFF unless the build flag is exactly `true`; make this an explicit hosted release
configuration and verify the deployed unauthenticated page shows login. Add the origin to the
portal API's CORS allowlist. Connected Qalatra data backends must also accept the hosted origin.
Bearer login is sufficient for V1; automatic SSO from an existing portal session is not built.

### Mobile release

Native already defaults to the production account API and requires a license. Validate a signed
device build against a real comp and paid/trial account, then upload a new EAS production build
to TestFlight. `mobile/eas.json` has production auto-increment enabled. Ensure the build uses
the mobile project configuration (there is also a root `eas.json`). Provide review credentials
and an accessible demo backend when submitting for review.

Apple documents a 90-day TestFlight build lifetime; a subscription change cannot renew an
expired binary: https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/

The intended native model is login-only access paid on the website. Apple's 3.1.3(f) permits
qualifying free companion apps without IAP if they contain no purchase UI or external purchase
calls to action. Approval is not established by this audit. The current unlicensed screen links
to `/team`; review its destination and remove/adapt purchase steering for the target storefronts.
Do not rely on the older plan's general claim that multiplatform services automatically avoid
IAP: 3.1.3(b) says otherwise. Current guidelines:
https://developer.apple.com/app-store/review/guidelines/#other-purchase-methods

## Recommended order

1. Add Connect comp grants and assign founder/reviewer seats.
2. Fix client revalidation, organization access, and multi-plan entitlement selection.
3. Deploy the hosted build and correct account/backend CORS; verify end-to-end access states.
4. Produce and device-test a signed mobile build, then upload it for TestFlight distribution.

The paywall controls the official hosted/published clients. Open-source self-hosted clients and
the free desktop remain available by design; this is not a server-side lock on users' own data.
