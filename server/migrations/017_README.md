# Migration 017 — Encrypt Microsoft Teams OAuth tokens at rest

**Change ID:** P0-5
**Type:** Security hardening (at-rest encryption)
**Boot-installed:** NO — operator-driven only.

## What this does

Backfills existing rows in the `users` table so that
`teamsAccessToken` and `teamsRefreshToken` are stored as
AES-256-GCM ciphertext (not plaintext).

The ciphertext format produced by `server/utils/encryption.js`:

```
<iv_hex(32)>:<authTag_hex(32)>:<ciphertext_hex>
```

The columns stay `TEXT` — no schema change.

## Code change summary (already in this commit/PR)

| File | Change |
|------|--------|
| `server/utils/teamsTokenStorage.js` | NEW. Exports `encryptTeamsToken`, `decryptTeamsTokenSafe`, `isEncryptedTeamsToken`. |
| `server/controllers/authController.js` | Writes in `microsoftCallback` wrapped with `encryptTeamsToken`. |
| `server/routes/teams.js` | Writes in `/api/teams/callback` wrapped with `encryptTeamsToken`. |
| `server/services/calendarService.js` | Reads in `getAccessToken` unwrapped with `decryptTeamsTokenSafe`; refresh-flow re-encrypts on write. |
| `server/models/User.js` | UNCHANGED. Columns remain `TEXT`. |
| `server.js` | UNCHANGED. Migration 017 is NOT auto-installed. |

### Dual-path reader (legacy-safe)

`decryptTeamsTokenSafe(stored)`:

- If `stored` matches the AES-GCM tuple regex → `decrypt()` and return plaintext.
- Otherwise → return `stored` as-is (legacy plaintext path).

This means existing plaintext rows keep working immediately after the
code deploy, BEFORE this backfill is run. After the backfill, every
row is ciphertext and the legacy path is unused. The fallback can
then be removed in a follow-up cleanup PR.

## Operator playbook

### Pre-flight

1. **Take a `pg_dump` snapshot** of the users table:
   ```bash
   pg_dump -h <host> -U postgres -d aniston_project_hub \
     --table=users --data-only \
     --file=/backups/users_pre_017_$(date +%Y%m%d_%H%M).sql
   ```
2. **Verify `ENCRYPTION_KEY` is set** in the backend environment and
   matches the value the running app uses (otherwise the encrypted
   tokens become unreadable). It must be a 64-character hex string
   (AES-256).
   ```bash
   docker exec aph-backend node -e "console.log(!!process.env.ENCRYPTION_KEY, process.env.ENCRYPTION_KEY?.length)"
   # expected:  true 64
   ```
3. Pick a **maintenance window**. Live traffic during the backfill is
   technically safe (the dual-path reader handles both plaintext and
   ciphertext), but a quiet window minimises the chance of a token
   being rotated mid-update by an unrelated OAuth refresh.

### Deploy & backfill

a. **Take the pg_dump snapshot** (step above).

b. **Deploy the code changes.** From this point onward:
   - All NEW token writes are encrypted.
   - All reads go through the dual-path reader and tolerate both
     plaintext and ciphertext.

c. **Run the backfill** (production requires the explicit gate flag):
   ```bash
   docker exec \
     -e ALLOW_PROD_TEAMS_TOKEN_ENCRYPT_BACKFILL=true \
     aph-backend node migrations/run_017.js
   ```
   The runner prints a pre-flight banner and a summary block at the end:
   ```
   Users scanned                       : N
   Rows updated                        : M
   teamsAccessToken  encrypted (new)   : ...
   teamsAccessToken  already encrypted : ...
   teamsRefreshToken encrypted (new)   : ...
   teamsRefreshToken already encrypted : ...
   Errors                              : 0
   ```

d. **Verify**: re-run the same command. It is idempotent. Expected:
   `encrypted (new) = 0` for both columns, every non-NULL row counted
   under `already encrypted`. If any row still encrypts on the second
   run, an OAuth refresh raced with the backfill — re-run once more.

e. **Spot-check** a few rows manually:
   ```sql
   SELECT
     id,
     CASE
       WHEN "teamsAccessToken" ~ '^[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]+$'
         THEN 'encrypted'
       WHEN "teamsAccessToken" IS NULL THEN 'null'
       ELSE 'PLAINTEXT'
     END AS access_state,
     CASE
       WHEN "teamsRefreshToken" ~ '^[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]+$'
         THEN 'encrypted'
       WHEN "teamsRefreshToken" IS NULL THEN 'null'
       ELSE 'PLAINTEXT'
     END AS refresh_state
   FROM users
   WHERE "teamsAccessToken" IS NOT NULL OR "teamsRefreshToken" IS NOT NULL;
   ```
   No row should report `PLAINTEXT` after the backfill.

### Follow-up cleanup (separate PR)

Once `encrypted (new) = 0` has been observed in EVERY environment
(dev, staging, prod) AND no plaintext rows remain (verified by the
SQL above), the dual-path reader is no longer doing anything useful.

In `server/utils/teamsTokenStorage.js`, replace the body of
`decryptTeamsTokenSafe`:

```js
// Cleanup version (after backfill complete in all environments):
function decryptTeamsTokenSafe(stored) {
  if (!stored) return null;
  try {
    return decrypt(stored);
  } catch (err) {
    console.error('[teamsTokenStorage] Failed to decrypt stored token:', err.message);
    return null;
  }
}
```

Update the JSDoc at the top of the file to remove the LEGACY block.

### Rollback

If something goes wrong before step (c) completes successfully:

```bash
psql -h <host> -U postgres -d aniston_project_hub \
  -f /backups/users_pre_017_<timestamp>.sql
```

If rollback happens AFTER the code is deployed: the dual-path reader
will continue to work on plaintext rows, so the restore alone is
sufficient — no code revert required.

If you must also revert the code: the encrypted writes will then be
read as "plaintext" by the old controller (an invalid Bearer token).
Affected users will need to disconnect/reconnect Teams once.

## Operator decision matrix

| Situation | Action |
|-----------|--------|
| Fresh environment, no Teams users yet | Skip the backfill. New writes are already encrypted. |
| Some Teams users, plaintext present | Run `run_017.js` once. |
| `run_017.js` reports errors | Investigate the per-row error message. Re-run (idempotent) once issues are fixed. |
| Backfill done in all environments | Open the dual-path-reader cleanup PR. |
