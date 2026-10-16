# App Review notes

Paste-ready reviewer instructions for App Store Connect (App Review Information → Notes, with the
email/password in the sign-in fields) and Google Play Console (App content → App access).

Replace `<PASSWORD>` and `<TOKEN>` by hand in the store consoles. Never commit them here. The token
belongs to the review server's portal credentials; rotate it after both reviews are approved, since
both review teams will have seen it.

- Review account: `review@qalatra.com` (2FA off, comp Connect seat + comp Cloud slot, org "Qalatra")
- Review server: `review` → `https://api-review.qalatra.com` (Qalatra Cloud, comp, sample data only)
- Server connections are per device, so reviewers must enter the URL and token after signing in.

---

```
Qalatra is a free companion app to the Qalatra web service, a task and agent workspace
running on a server the user owns or rents through Qalatra Cloud. Accounts and servers
are set up at qalatra.com. The app has no sign-up, no purchases, and no calls to action
to purchase (guideline 3.1.3(f)).

A Qalatra account is required, and the server where tasks live is connected separately
on each device.

DEMO ACCOUNT
Email: review@qalatra.com
Password: <PASSWORD>

DEMO SERVER (needed after signing in)
Server URL: https://api-review.qalatra.com
Access token: <TOKEN>

STEPS
1. Open the app and sign in with the email and password above.
2. On "Connect your Qalatra server", enter the Server URL and Access token above.
   Server name is optional. The token goes in the "Access Token" field, not the
   account password.
3. Tap "Connect server". The Priority list opens.

WHAT TO TRY
- Priority tab: today's tasks. Tap a task to open it and edit the title, priority,
  due date, description, or notes.
- Search tab: find any task.
- Create a task with the + button.
- More: Daily Note, Habits, Backlog, Terminals, and Files. Under More you can also
  switch, add, or remove servers (Backends).

NOTES
- The demo server is a dedicated review environment with sample data. Feel free
  to create, edit, or complete tasks.
- The connection is saved on the device. To start over, remove the server under
  More → Backends and connect again.
- Contact: support@qalatra.com
```

## App Store Connect fields

- Sign-in required: yes. Username `review@qalatra.com`, password `<PASSWORD>`.
- Contact: Justin Handley, support@qalatra.com, phone (yours — Apple requires one).
- `store.config.json` sets the contact name/email, demo username and these notes with placeholders.
  Running `eas metadata:push` again overwrites whatever you typed into Notes/password in App Store
  Connect, so re-paste the token and password after any push.

## Google Play: App access

Choose "All or some functionality is restricted", add one instruction set named "Demo account and
server", and paste the block above with the real password and token filled in.
