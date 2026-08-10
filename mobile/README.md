# Qalatra Mobile (Expo)

Native iOS / iPad / Android client. Shares its entire data layer (types, API
client, instance/backend management) with the desktop app via `@qalatra/shared`.
Remote-only: it connects to a headless Qalatra backend by URL + token and never
runs a local server.

See `plan/EXPO_MOBILE_ROADMAP.md` for the full plan.

## Status: V1 source complete; device release validation pending

The shared data layer, remote-backend onboarding, application screens, qalatra.com account login,
2FA, secure token persistence, and Connect/Cloud-seat entitlement gate are implemented and pass
TypeScript checks. A signed build still needs real iOS/Android device testing and store review.

## First run

```bash
cd mobile
npm install
# Align dependency versions to the current Expo SDK (the versions in package.json
# are indicative — this fixes them to a mutually compatible set):
npx expo install --fix
npx expo start            # then press i (iOS), a (Android), or scan with Expo Go
```

If Metro can't resolve `@qalatra/shared`, confirm `metro.config.js`'s
`watchFolders` / `extraNodeModules` point at `../packages/shared` and restart with
`npx expo start -c` (clear cache).

## How it's wired

- `src/platform.native.ts` — installs the `@qalatra/shared` platform adapter: AsyncStorage for
  application state, Expo SecureStore for the account credential, and
  `canManageLocalServer: false` (no local-server fallback).
- `App.tsx` — hydrates account/backend state, verifies an active assigned Connect or included Cloud
  seat, then routes to onboarding (no backend configured) or the main shell.
- `src/AppShell.tsx` — adaptive: master-detail on tablet/regular width, single
  column on phone (`src/hooks/useLayout.ts`, branches on width, not device).
- `src/screens/` — `OnboardingScreen` (paste URL + token) and `TodayScreen`
  (today's tasks via `fetchTasks`).

## Not a workspace

`mobile/` is deliberately excluded from the root npm workspaces so the desktop
release pipeline's `npm ci` never installs Expo/RN. It resolves `@qalatra/shared`
through Metro + tsconfig paths instead.

## Next (roadmap Phase 4–5)

- Real navigation for the phone detail route.
- More screens toward parity (detail + notes, triage, capture, briefings).
- Expo push notifications for heartbeats/reminders.
