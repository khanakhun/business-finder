import { describe, expect, it } from 'vitest';
import { hamming } from '../../domain/assets/dhash.ts';
import { SharpImageProcessor } from '../sharp-image-processor.ts';
import { FakeImageFetcher } from './sourcing.adapters.ts';

// The fake downloads stand in for real photos in tests and E2E: each URL must be a distinct, sharp picture.
describe('FakeImageFetcher', () => {
  it('draws a sharp picture per URL, never a near-duplicate of another', async () => {
    const images = new SharpImageProcessor();
    const fetcher = new FakeImageFetcher();
    const urls = ['terrasse', 'salon', 'vitrine', 'equipe', 'carte'].map(
      (name) => `https://salon-lumiere.example/img/${name}.jpg`,
    );
    const measured = await Promise.all(
      urls.map(async (url) => images.measure(Buffer.from(await fetcher.fetch(url)))),
    );
    for (const [i, a] of measured.entries()) {
      expect(a.sharpness).toBeGreaterThan(60);
      for (const b of measured.slice(i + 1)) expect(hamming(a.dhash, b.dhash)).toBeGreaterThan(6);
    }
  });
});
