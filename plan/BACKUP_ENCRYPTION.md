# Backup & Encryption Plan

## Goals
- Client-side AES-256-GCM encryption for all R2 content (attachments + DB backups)
- Encryption key stored in macOS Keychain, exportable for safe storage
- Hourly + on-quit DB backups to a dedicated R2 bucket
- Settings export/import for full disaster recovery
- Manual restore (pick a backup from a list in Settings)
- Restore instructions doc in qalatra.com

## Recovery Kit (what user saves externally)
1. **Encryption key export** → secure drive or 1Password
2. **Settings export** → 1Password
   Together these are sufficient to fully restore on a new machine.

## New Settings Fields
- `backupBucket` — R2 bucket name for DB backups (separate from `s3Bucket`)
- No key field in settings — key lives in Keychain only

## Encryption Key Management
- On first run (or via Settings button): generate a 256-bit key, store in macOS Keychain
  - Service: `qalatra`, Account: `encryptionKey`
- **Export**: read from Keychain, present as base64 string for user to copy/save
- **Import**: accept base64 string, write to Keychain
- Node API: `keytar` package (already used by Electron ecosystem) or `safeStorage` (Electron built-in — preferred, no extra dep)

### Electron safeStorage vs keytar
- `safeStorage` is built into Electron, uses macOS Keychain under the hood
- Encrypts a buffer, stores result wherever we choose (e.g. a `keystore` file next to settings.json)
- `safeStorage.encryptString(key)` → encrypted buffer → save to `db/keystore`
- `safeStorage.decryptString(buffer)` → key
- Export: decrypt from keystore, present as base64
- Import: accept base64, encrypt with safeStorage, save to keystore
- This is simpler than raw keytar and has no native module ABI issues

## Encryption Scheme
```
encrypt(plaintext: Buffer, key: Buffer) → { iv, ciphertext, authTag }
  iv = crypto.randomBytes(12)         // 96-bit IV for GCM
  cipher = createCipheriv('aes-256-gcm', key, iv)
  ciphertext = cipher.update(plaintext) + cipher.final()
  authTag = cipher.getAuthTag()       // 16 bytes
  output = Buffer.concat([iv, authTag, ciphertext])  // 12 + 16 + N bytes

decrypt(data: Buffer, key: Buffer) → Buffer
  iv = data.slice(0, 12)
  authTag = data.slice(12, 28)
  ciphertext = data.slice(28)
  decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  return decipher.update(ciphertext) + decipher.final()
```

## File Layout
```
electron-main.js          ← add backup scheduler (setInterval + before-quit)
ipc-handlers.js           ← add backup:run, backup:list, backup:restore,
                             key:generate, key:export, key:import,
                             settings:export, settings:import,
                             encryption:migrate (re-encrypt existing attachments)
crypto.js (new)           ← encrypt/decrypt helpers, key load/save via safeStorage
s3.js                     ← add uploadEncrypted, downloadDecrypted helpers
ui/src/components/
  Settings.tsx            ← new sections: Backup, Encryption Key, Settings Export
```

## DB Backup Flow
```
1. Call better-sqlite3 .backup(tmpPath) → consistent snapshot regardless of WAL state
2. Read tmpPath into Buffer
3. Encrypt buffer with encryptionKey
4. Upload to backupBucket as db/tasks-{ISO timestamp}.db.enc
5. Delete tmpPath
6. Prune: delete backups older than 30 days from R2 (list objects, filter, delete)
```

### Scheduling
- `setInterval` in electron-main.js: every 60 minutes
- `app.on('before-quit')`: run backup (with timeout guard so it doesn't hang quit)
- IPC `backup:run` for manual trigger from Settings UI

## Attachment Encryption

### New uploads (going forward)
- In `ipc-handlers.js` upload path: encrypt buffer before `uploadToS3`
- In `syncPendingAttachments`: encrypt before upload
- Add `encrypted` column to attachments table (INTEGER DEFAULT 0)

### Download / serve
- When generating presigned URL: not viable for encrypted content
- Instead: add `attachments:download` IPC handler
  - Fetch object from R2 as buffer
  - Decrypt
  - Return buffer to frontend (or write to temp file + return path)
- Frontend: for encrypted attachments, call `attachments:download` instead of opening presigned URL directly

### Migration (re-encrypt existing attachments)
- `encryption:migrate` IPC handler
- For each attachment with bucket+key but encrypted=0:
  - Download from R2
  - Encrypt
  - Re-upload (same key)
  - Set encrypted=1
- Currently 0 attachments in DB, so migration is a no-op for now but code handles it

## Settings Export/Import
- **Export**: read settings.json, return as JSON string (presented in UI for copy/paste or file save)
- **Import**: accept JSON string, merge into settings.json, reload
- Does NOT include encryption key (that's a separate export)
- Store in 1Password as a secure note

## Settings UI Changes (Settings.tsx)

### New section: Backup
- `backupBucket` field
- Last backup time + status
- "Run backup now" button
- "Restore from backup" — lists last 20 backups from R2, pick one, confirm

### New section: Encryption
- Status: key present / not present
- "Generate new key" (warns if key exists)
- "Export key" → shows base64 in a modal, user copies to secure storage
- "Import key" → paste base64

### New section: Recovery
- "Export settings" → shows JSON or triggers file download
- "Import settings" → paste or file upload

## Restore Flow (manual, new machine)
1. Install Qalatra
2. Settings → Recovery → Import settings (paste from 1Password)
3. Settings → Encryption → Import key (paste from 1Password / secure drive)
4. Settings → Backup → Restore from backup → pick latest → confirm
5. App restarts with restored DB

## qalatra.com Docs
- Add `ai-docs/backup-restore.md` with full recovery instructions
- Cover: what the recovery kit is, where to store it, step-by-step restore flow

## Implementation Order
1. `crypto.js` — encrypt/decrypt helpers
2. Key management — generate, safeStorage save/load, export/import IPC handlers
3. DB backup — backup:run, scheduling, backup:list, backup:restore
4. Settings export/import
5. Attachment encryption — upload path, download path, migration
6. Settings UI — all new sections
7. qalatra.com docs
