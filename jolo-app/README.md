# JOLO app

One app, two sides, picked at sign-in by phone number:

- **Owners** (the phone is a café's `ownerPhone`): **see your live menu, edit it, look back through its versions, and read weekly insights.**
- **Everyone else** gets the original JOLO interface: Finder (map of nearby cafés), Social, Favorites and Profile.

 It's an Expo / React Native app built on the [JOLO app](https://github.com/zayguz/JOLO) (`~/JOLO_app`).

Reused from the JOLO app:
- React Native Firebase and the dev-build setup
- per-environment Firebase files
- the Aroma & Crema design tokens and fonts
- the email sign-in, register and reset screens, plus the auth context
- the error messages
- the lint, format and test configuration
- the existing `users` Firestore rules
- the customer tabs (Finder, Social, Favorites, Profile), with maps, location and the Union County café data

New here:
- phone sign-in
- the owner dashboard
- menu versioning
- the owner-only Firestore rules

The data shapes are agreed in [`../docs/contracts.md`](../docs/contracts.md).

```
app/
  (login)/            signed out: phone sign-in (first), email sign-in / register / reset
  owner/              signed in, phone owns a café: Menu · History · Insights · Account tabs
  user/               signed in, anyone else: Finder · Social · Favorites · Profile (the original JOLO app)
features/for-you/     parked drink-recommendation screens; not routed (see ../docs/drink-recommendations.md)
data/cafes/           Union County cafés from OpenStreetMap, for seed:cafes
components/           Button, Banner, MenuItemRow, ItemEditor, ChangeList, EmptyState, …
hooks/                useOwnerCafe, useCurrentMenu / useMenuHistory, useInsights (all live listeners)
lib/                  auth, menu logic (pure, tested), menu-store (the one write), phone, insights
firestore.rules       owner-only menu writes; immutable history; shared users rules
scripts/              seed-emulator.mjs, seed-cafes.mjs, link-owner.mjs
tests/rules/          Firestore rules tests (emulator)
tests/screens/        screen tests (Jest + React Native Testing Library)
```

## How it fits the flow

| In the sequence diagram | Here |
|---|---|
| "Owner dashboard in the app updates live from Firestore" (step 19) | The Menu tab listens to `cafes/{id}` and the current `menuVersions` doc, so a menu texted in by iMessage appears without a refresh. |
| "Save version 4 … keep version 3 as history" (step 18) | Saving in the app does the same: one transaction creates `menuVersions/{N+1}` and moves `currentMenuVersion`. The History tab shows every version and its changes. |
| Owner insights (Bhavesh) | The Insights tab reads `cafes/{id}/insights/{week}`. It shows any count the agent writes, plus the LLM summary. |

**Ownership** works like this:
1. The owner signs in with Firebase Phone Auth, so their phone number is verified.
2. The app finds the café whose `ownerPhone` equals that number.
3. The Firestore rules check the same thing on every write.

Email accounts still sign in, but they can't manage a café. Only `scripts/link-owner.mjs` (Admin SDK) can set `ownerPhone`.

## Prerequisites

- Node 20+ and npm
- Xcode (iOS Simulator) and/or Android Studio. The app uses native Firebase modules, so it runs as a [development build](https://docs.expo.dev/develop/development-builds/introduction/), not in Expo Go.
- Java 21+ for the Firestore emulator (`npm run emulators`, `npm run test:rules`). This Mac has Java 17. To install 21:

  ```bash
  brew install --cask temurin@21
  ```

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. **Firebase console** (project `jolo-ec76d`, or a separate hackathon project):
   - Authentication → Sign-in method: enable **Phone** (and keep Email/Password on).
   - Authentication → Sign-in method → Phone → **Phone numbers for testing**: add your demo number with a fixed code. This lets you sign in without a real text.
   - Project settings → Your apps: add iOS app `com.zayguz.jolo.owner.dev` (and Android app `com.zayguz.jolo.owner.dev`). Save their config files as `firebase/dev/GoogleService-Info.plist` and `firebase/dev/google-services.json`. The `firebase/` folder is git-ignored.

3. Build and run the development app (the first build takes a few minutes):

   ```bash
   npm run ios
   ```

   If `pod install` fails with `Unicode Normalization not appropriate for ASCII-8BIT`, run `export LANG=en_US.UTF-8` first.

4. Link a café to the owner's phone with a service account key from Project settings → Service accounts. The key is git-ignored. Run it once as a dry run, then add `--yes`:

   ```bash
   npm run link-owner -- --service-account ./service-account.json --cafe osm-node-123 --phone "(908) 555-1234"
   ```

5. Deploy the rules. Read the warning below first.

   ```bash
   npx firebase deploy --only firestore:rules
   ```

> **Shared project.** The JOLO customer app uses `jolo-ec76d` too. Deploying `firestore.rules` from either app replaces the rules for both. This file includes the JOLO app's `users` rules unchanged for that reason. Its `cafes` rules differ from the JOLO app's: a verified owner may now move their café's menu pointer, and menus and insights become readable. Deploy from one place, or give the hackathon its own Firebase project.

## Demo without touching real data

This needs Java 21. Start the emulators:

```bash
npm run emulators
```

In a second terminal, seed the demo café "Barbara's" (owner +1 650-555-1234, menu versions 1–3, two weeks of insights):

```bash
npm run seed:emulator
```

Then start the app against the emulators:

```bash
EXPO_PUBLIC_USE_FIREBASE_EMULATORS=1 npm start
```

Sign in with **(650) 555-1234**. The emulator never sends a text: the code appears in the emulator UI at <http://localhost:4000/auth>. On a physical phone, set `EXPO_PUBLIC_EMULATOR_HOST` to your Mac's LAN IP.

To show the "updates live" moment, edit `cafes/demo-barbaras` in the emulator UI. (The stub agent keeps its menu in memory and never writes Firestore, so a photo sent through it won't show up here; that needs the real agent.)

## Scripts

| Command | What it does |
|---|---|
| `npm run ios` / `npm run android` | Build and run the dev app |
| `npm start` | Metro, for an installed dev build |
| `npm test` | Unit and screen tests (Jest) |
| `npm run test:rules` | Firestore rules tests against the emulator (Java 21+) |
| `npm run lint`, `npm run format:check`, `npm run typecheck` | Static checks; CI runs all of these |
| `npm run emulators` | Local Auth and Firestore emulators |
| `npm run seed:emulator` | Demo café in the emulator; refuses to run against anything else |
| `npm run seed:cafes` | The ~70 Union County cafés for the Finder, into the emulator only. `FIRESTORE_PROJECT_ID` defaults to `jolo-ec76d`, the project the app reads |
| `npm run link-owner -- …` | Set or unset a café's `ownerPhone` (dry run unless `--yes`) |

Optional env: `EXPO_PUBLIC_JOLO_IMESSAGE_HANDLE`, the number owners text their menu to, is shown on the Account tab.

## Not done yet

- **Linking a phone to an email account.** An email user has to sign out and use phone sign-in. `linkWithCredential` would let them keep one account.
- **Choosing between several cafés.** If one phone owns several cafés, the app shows the first.
- **Social and Favorites** still show the original app's placeholder content; they don't read Firestore yet.
- **Owner-created cafés have no map pin.** A café linked over iMessage has an address but no coordinates, so the Finder lists it without a marker.
- **Drink recommendations are parked.** The For you screens, event log and `../recommend/` worker are in the repo but not routed.
