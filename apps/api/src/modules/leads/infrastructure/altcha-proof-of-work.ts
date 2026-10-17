import { createChallenge, randomInt, verifySolution } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';
import type { ProofOfWork } from '../application/ports.ts';

// ALTCHA proof of work (BF-048): self-hosted (no third-party request from the renderer), signed with our secret,
// valid for 20 minutes. Harder while a site receives spam. A solved challenge is used once (the guard checks).

const EXPIRES_MS = 20 * 60_000;

export class AltchaProofOfWork implements ProofOfWork {
  constructor(
    private readonly signatureSecret: string,
    private readonly keySecret: string,
  ) {}

  async challenge({ siteId, hard }: { siteId: string; hard: boolean }) {
    const cost = hard ? 20_000 : 5_000;
    const challenge = await createChallenge({
      algorithm: 'PBKDF2/SHA-256',
      cost,
      counter: randomInt(cost, cost * 2),
      deriveKey,
      expiresAt: new Date(Date.now() + EXPIRES_MS),
      data: { site: siteId.slice(0, 40) },
      hmacSignatureSecret: this.signatureSecret,
      hmacKeySignatureSecret: this.keySecret,
    });
    return challenge as unknown as Record<string, unknown>;
  }

  async verify(payload: string) {
    try {
      const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as {
        challenge?: unknown;
        solution?: unknown;
      };
      if (!decoded.challenge || !decoded.solution) return { ok: false, signature: null };
      const challenge = decoded.challenge as Parameters<typeof verifySolution>[0]['challenge'];
      const result = await verifySolution({
        challenge,
        solution: decoded.solution as Parameters<typeof verifySolution>[0]['solution'],
        deriveKey,
        hmacSignatureSecret: this.signatureSecret,
        hmacKeySignatureSecret: this.keySecret,
      });
      return { ok: result.verified, signature: challenge.signature ?? null };
    } catch {
      return { ok: false, signature: null };
    }
  }
}
