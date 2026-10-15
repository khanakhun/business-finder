import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Envelope encryption for workspace secrets (security.md §2, BF-011): a random 256-bit data key (DEK) per secret
// encrypts the value with AES-256-GCM; the master key wraps the DEK with AES-256-GCM too. Node's crypto only.

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12; // 96-bit nonces, as NIST SP 800-38D recommends for GCM
const TAG_BYTES = 16;

export interface GcmBox {
  readonly ciphertext: Buffer;
  readonly iv: Buffer;
  readonly tag: Buffer;
}

/** What the `secrets` table stores for one value. */
export interface SealedSecret {
  readonly ciphertext: Buffer;
  readonly iv: Buffer;
  readonly authTag: Buffer;
  readonly wrappedDek: Buffer;
  readonly dekIv: Buffer;
  readonly dekTag: Buffer;
}

/** Thrown when a box does not authenticate: wrong key, wrong context (AAD) or tampered bytes. No details leak. */
export class DecryptionError extends Error {
  constructor() {
    super('Decryption failed');
    this.name = 'DecryptionError';
  }
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) throw new RangeError(`Expected a ${KEY_BYTES}-byte key`);
}

/** AES-256-GCM encryption; `iv` is random unless given (tests only — a reused nonce breaks GCM). */
export function gcmEncrypt(
  key: Buffer,
  plaintext: Buffer,
  aad: Buffer,
  iv: Buffer = randomBytes(IV_BYTES),
): GcmBox {
  assertKey(key);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

export function gcmDecrypt(key: Buffer, box: GcmBox, aad: Buffer): Buffer {
  assertKey(key);
  if (box.iv.length !== IV_BYTES || box.tag.length !== TAG_BYTES) throw new DecryptionError();
  try {
    const decipher = createDecipheriv(ALGORITHM, key, box.iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(box.tag);
    return Buffer.concat([decipher.update(box.ciphertext), decipher.final()]);
  } catch {
    throw new DecryptionError();
  }
}

/**
 * Additional authenticated data. The value is bound to its workspace and name, so a row copied to another
 * workspace or name does not decrypt; the wrapped DEK is also bound to the master key version.
 *
 * DECISION(BF-011): the value's AAD omits `keyVersion` (the ticket binds `orgId|name|keyVersion` to both), so a
 * master key rotation only re-wraps DEKs and never decrypts the secret values themselves.
 */
export const valueAad = (orgId: string, name: string) => Buffer.from(`bf.secret.v1|${orgId}|${name}`, 'utf8');
export const dekAad = (orgId: string, name: string, keyVersion: number) =>
  Buffer.from(`bf.dek.v1|${orgId}|${name}|${keyVersion}`, 'utf8');

export interface SecretContext {
  readonly orgId: string;
  readonly name: string;
  readonly keyVersion: number;
}

/** Encrypts `plaintext` under a fresh DEK, then wraps the DEK with `masterKey`. */
export function sealSecret(plaintext: string, masterKey: Buffer, context: SecretContext): SealedSecret {
  const dek = randomBytes(KEY_BYTES);
  try {
    const value = gcmEncrypt(dek, Buffer.from(plaintext, 'utf8'), valueAad(context.orgId, context.name));
    const wrapped = gcmEncrypt(masterKey, dek, dekAad(context.orgId, context.name, context.keyVersion));
    return {
      ciphertext: value.ciphertext,
      iv: value.iv,
      authTag: value.tag,
      wrappedDek: wrapped.ciphertext,
      dekIv: wrapped.iv,
      dekTag: wrapped.tag,
    };
  } finally {
    dek.fill(0);
  }
}

function unwrapDek(sealed: SealedSecret, masterKey: Buffer, context: SecretContext): Buffer {
  return gcmDecrypt(
    masterKey,
    { ciphertext: sealed.wrappedDek, iv: sealed.dekIv, tag: sealed.dekTag },
    dekAad(context.orgId, context.name, context.keyVersion),
  );
}

export function openSecret(sealed: SealedSecret, masterKey: Buffer, context: SecretContext): string {
  const dek = unwrapDek(sealed, masterKey, context);
  try {
    return gcmDecrypt(
      dek,
      { ciphertext: sealed.ciphertext, iv: sealed.iv, tag: sealed.authTag },
      valueAad(context.orgId, context.name),
    ).toString('utf8');
  } finally {
    dek.fill(0);
  }
}

/** Master key rotation: re-wraps the DEK under `to`; the value ciphertext is untouched. */
export function rewrapSecret(
  sealed: SealedSecret,
  from: { readonly key: Buffer; readonly version: number },
  to: { readonly key: Buffer; readonly version: number },
  context: { readonly orgId: string; readonly name: string },
): SealedSecret {
  const dek = unwrapDek(sealed, from.key, { ...context, keyVersion: from.version });
  try {
    const wrapped = gcmEncrypt(to.key, dek, dekAad(context.orgId, context.name, to.version));
    return { ...sealed, wrappedDek: wrapped.ciphertext, dekIv: wrapped.iv, dekTag: wrapped.tag };
  } finally {
    dek.fill(0);
  }
}
