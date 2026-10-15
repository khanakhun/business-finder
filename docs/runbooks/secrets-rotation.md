# Runbook — rotating the secrets master key

Workspace secrets (provider API keys…) are envelope-encrypted (BF-011, [security.md §2](../conventions/security.md#2-secrets)):
each value is encrypted with its own random data key (AES-256-GCM), and that data key is stored wrapped by the
**master key** `SECRETS_MASTER_KEY`. Rotating the master key re-wraps the data keys; secret values are never
decrypted during rotation and their ciphertext does not change.

## When

- Suspected exposure of `SECRETS_MASTER_KEY` (rotate immediately), staff changes, or on a fixed schedule.

## Steps

1. Generate the new key: `openssl rand -base64 32`.
2. Update the environment of **every** API and worker process, then redeploy:
   - `SECRETS_MASTER_KEY` = the new key
   - `SECRETS_MASTER_KEY_VERSION` = previous version + 1 (the default is `1`)
   - `SECRETS_MASTER_KEY_PREVIOUS` = the old key

   From now on new secrets are written with the new key, and existing ones are still readable with the old one.
3. Run `pnpm secrets:rotate-master` once (any host with the new environment and database access). It prints how
   many secrets it re-wrapped and records `secrets.master_key_rotated` in the audit log. It is idempotent and
   resumable: run it again after an interruption; a second run re-wraps 0.
4. If it reports secrets it could not open (exit code 1), they are wrapped by an older version than
   `SECRETS_MASTER_KEY_PREVIOUS`: rotate in steps (set that older key as previous with the matching version,
   run, then continue).
5. Once it reports 0 remaining, remove `SECRETS_MASTER_KEY_PREVIOUS` everywhere and redeploy. Destroy the old key.

## Notes

- Each process caches decrypted values for at most 60 s; rotation does not change values, so caches stay valid.
- A KMS-backed `MasterKeyProvider` can replace the environment provider later without changing stored rows.
