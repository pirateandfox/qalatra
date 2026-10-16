# Privacy, data safety and content questionnaires

These have no API on either store, so they are clicked through by hand. Answers below are based on
the 0.3.1 code: no analytics, crash-reporting or ad SDKs (see `../package.json`), account sign-in
against api.qalatra.com, and task data sent to the server the user connects.

Why user content is declared at all: for self-hosted servers the data never reaches us, but Qalatra
Cloud servers run on our infrastructure, so we declare it conservatively. None of it is used for
tracking, advertising or analytics.

## Apple: App Privacy (App Store Connect → App Privacy)

Data collection: **Yes, we collect data from this app.**

| Category → type | Use | Linked to user | Tracking |
|---|---|---|---|
| Contact Info → Email Address | App Functionality | Yes | No |
| Contact Info → Name | App Functionality | Yes | No |
| User Content → Photos or Videos | App Functionality | Yes | No |
| User Content → Other User Content | App Functionality | Yes | No |
| Identifiers → User ID | App Functionality | Yes | No |

Not collected: Health & Fitness, Financial Info, Location, Sensitive Info, Contacts, Browsing
History, Search History, Usage Data, Diagnostics, Purchases, Other Data.

Privacy policy URL: https://qalatra.com/privacy

## Apple: other version fields

- Age rating: every question "None"/No → 4+. Already in `../store.config.json` (`advisory`).
  "Unrestricted web access" is No: the Tools tab only shows the user's own server, and every other
  link opens in the system browser.
- Export compliance: `ITSAppUsesNonExemptEncryption: false` is in `app.json`, so no question appears.
- Content rights: does not contain, show or access third-party content → No.
- Advertising identifier (IDFA): No.

## Google Play: Data safety (Play Console → App content → Data safety)

- Does your app collect or share any of the required user data types? **Yes**
- Is all user data encrypted in transit? **Yes**
- Do you provide a way for users to request that their data is deleted? **Yes**
- Account deletion URL: https://qalatra.com/support#delete-account

Data types (collected, **not shared**, processed for **App functionality** and, where noted,
**Account management**):

| Data type | Required or optional | Purposes |
|---|---|---|
| Personal info → Name | Optional | App functionality, Account management |
| Personal info → Email address | Required | App functionality, Account management |
| Personal info → User IDs | Required | App functionality, Account management |
| Photos and videos → Photos | Optional | App functionality |
| Files and docs → Files and docs | Optional | App functionality |
| App activity → Other user-generated content | Required | App functionality |

For each: collected = Yes, shared = No, processed ephemerally = No.
Not collected: location, financial info, health, messages, audio, contacts, calendar, app
interactions/in-app search history, web browsing, device or other IDs, crash logs, diagnostics.

## Google Play: other App content declarations

- Privacy policy: https://qalatra.com/privacy
- App access: restricted → see `REVIEW_NOTES.md`
- Ads: **No, my app does not contain ads**
- Content rating (IARC questionnaire): email support@qalatra.com, category **"All Other App Types"**
  (utility/productivity). Violence, sexuality, language, controlled substances, gambling: all No.
  Users interact or exchange content with other users: No. Shares user location: No. Digital
  purchases: No. Unrestricted internet access: No. Expected result: Everyone / PEGI 3.
- Target audience and content: **18 and over** only. Not appealing to children: confirm.
- News app: No. COVID-19 contact tracing: No. Government app: No. Financial features: None.
  Health: None. Data deletion: as above.
- Store settings: app category **Productivity**, tags e.g. "To-do list", "Productivity".
  Contact email support@qalatra.com, website https://qalatra.com.
