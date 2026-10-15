import { describe, expect, it } from 'vitest';
import {
  DecryptionError,
  gcmDecrypt,
  gcmEncrypt,
  openSecret,
  rewrapSecret,
  type SealedSecret,
  sealSecret,
} from './envelope.ts';

const hex = (value: string) => Buffer.from(value, 'hex');

// NIST GCM specification (McGrew & Viega), test case 16: AES-256, 96-bit IV, with AAD.
const NIST = {
  key: hex('feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308'),
  iv: hex('cafebabefacedbaddecaf888'),
  plaintext: hex(
    'd9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39',
  ),
  aad: hex('feedfacedeadbeeffeedfacedeadbeefabaddad2'),
  ciphertext: hex(
    '522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662',
  ),
  tag: hex('76fc6ece0f4e1768cddf8853bb2d551b'),
};

const masterV1 = Buffer.alloc(32, 1);
const masterV2 = Buffer.alloc(32, 2);
const context = { orgId: '01990000-0000-7000-8000-000000000001', name: 'google_places', keyVersion: 1 };
const flip = (buffer: Buffer, index = 0) => {
  const copy = Buffer.from(buffer);
  copy[index] = (copy[index] ?? 0) ^ 0x01;
  return copy;
};

describe('AES-256-GCM primitive', () => {
  it('matches the NIST known-answer vector', () => {
    const box = gcmEncrypt(NIST.key, NIST.plaintext, NIST.aad, NIST.iv);
    expect(box.ciphertext.toString('hex')).toBe(NIST.ciphertext.toString('hex'));
    expect(box.tag.toString('hex')).toBe(NIST.tag.toString('hex'));
    expect(gcmDecrypt(NIST.key, box, NIST.aad).equals(NIST.plaintext)).toBe(true);
  });

  it('rejects a modified ciphertext, tag, nonce or AAD', () => {
    const box = { ciphertext: NIST.ciphertext, iv: NIST.iv, tag: NIST.tag };
    expect(() => gcmDecrypt(NIST.key, { ...box, ciphertext: flip(box.ciphertext, 5) }, NIST.aad)).toThrow(
      DecryptionError,
    );
    expect(() => gcmDecrypt(NIST.key, { ...box, tag: flip(box.tag) }, NIST.aad)).toThrow(DecryptionError);
    expect(() => gcmDecrypt(NIST.key, { ...box, iv: flip(box.iv) }, NIST.aad)).toThrow(DecryptionError);
    expect(() => gcmDecrypt(NIST.key, box, flip(NIST.aad))).toThrow(DecryptionError);
    expect(() => gcmDecrypt(NIST.key, { ...box, tag: box.tag.subarray(0, 8) }, NIST.aad)).toThrow(
      DecryptionError,
    );
  });

  it('refuses keys that are not 256-bit', () => {
    expect(() => gcmEncrypt(Buffer.alloc(16), Buffer.from('x'), Buffer.alloc(0))).toThrow(RangeError);
  });

  it('uses a fresh nonce per encryption', () => {
    const a = gcmEncrypt(masterV1, Buffer.from('same'), Buffer.alloc(0));
    const b = gcmEncrypt(masterV1, Buffer.from('same'), Buffer.alloc(0));
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });
});

describe('envelope', () => {
  const plaintext = 'sentinel-secret-value-ÆØÅ-0123456789';

  it('round-trips, and never stores the plaintext or the data key in clear', () => {
    const sealed = sealSecret(plaintext, masterV1, context);
    expect(openSecret(sealed, masterV1, context)).toBe(plaintext);
    const stored = Buffer.concat(Object.values(sealed));
    expect(stored.includes(Buffer.from(plaintext))).toBe(false);
    expect(sealed.wrappedDek).toHaveLength(32);
    expect(sealed.iv).toHaveLength(12);
    expect(sealed.authTag).toHaveLength(16);
  });

  it('gives each secret its own data key', () => {
    const a = sealSecret(plaintext, masterV1, context);
    const b = sealSecret(plaintext, masterV1, context);
    expect(a.wrappedDek.equals(b.wrappedDek)).toBe(false);
  });

  it.each<[string, (sealed: SealedSecret) => SealedSecret]>([
    ['ciphertext', (s) => ({ ...s, ciphertext: flip(s.ciphertext) })],
    ['auth tag', (s) => ({ ...s, authTag: flip(s.authTag) })],
    ['wrapped data key', (s) => ({ ...s, wrappedDek: flip(s.wrappedDek) })],
    ['data key tag', (s) => ({ ...s, dekTag: flip(s.dekTag) })],
  ])('detects a tampered %s', (_, tamper) => {
    const sealed = sealSecret(plaintext, masterV1, context);
    expect(() => openSecret(tamper(sealed), masterV1, context)).toThrow(DecryptionError);
  });

  it('is bound to its workspace, name and key version (AAD)', () => {
    const sealed = sealSecret(plaintext, masterV1, context);
    const otherOrg = { ...context, orgId: '01990000-0000-7000-8000-000000000002' };
    expect(() => openSecret(sealed, masterV1, otherOrg)).toThrow(DecryptionError);
    expect(() => openSecret(sealed, masterV1, { ...context, name: 'openai' })).toThrow(DecryptionError);
    expect(() => openSecret(sealed, masterV1, { ...context, keyVersion: 2 })).toThrow(DecryptionError);
    expect(() => openSecret(sealed, masterV2, context)).toThrow(DecryptionError);
  });

  it('re-wraps for a new master key without touching the value ciphertext', () => {
    const sealed = sealSecret(plaintext, masterV1, context);
    const rotated = rewrapSecret(
      sealed,
      { key: masterV1, version: 1 },
      { key: masterV2, version: 2 },
      { orgId: context.orgId, name: context.name },
    );
    expect(rotated.ciphertext.equals(sealed.ciphertext)).toBe(true);
    expect(rotated.wrappedDek.equals(sealed.wrappedDek)).toBe(false);
    expect(openSecret(rotated, masterV2, { ...context, keyVersion: 2 })).toBe(plaintext);
    expect(() => openSecret(rotated, masterV1, context)).toThrow(DecryptionError);
  });

  it('refuses to re-wrap with the wrong previous key', () => {
    const sealed = sealSecret(plaintext, masterV1, context);
    expect(() =>
      rewrapSecret(sealed, { key: masterV2, version: 1 }, { key: masterV2, version: 2 }, context),
    ).toThrow(DecryptionError);
  });
});
