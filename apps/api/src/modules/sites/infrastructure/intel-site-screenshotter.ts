import { ExternalServiceError, SiteIntelRequestSchema, SiteIntelSchema } from '@bf/contracts';
import { Injectable } from '@nestjs/common';
import { BrokenCircuitError } from 'cockatiel';
import sharp from 'sharp';
import { IntelClient } from '../../platform/intel/intel-client.ts';
import type { ObjectStorage } from '../../platform/storage/object-storage.ts';
import type { SiteScreenshotter } from '../application/ports.ts';

/** Seconds intel may spend on the page. */
const CAPTURE_SECONDS = 45;

/**
 * Screenshots through services/intel's site analysis (BF-026) limited to the home page: its browser, its SSRF guard
 * and its artifact upload are reused rather than duplicated here.
 */
// DECISION(BF-035): intel resolves the preview hostname like any site; a local `*.localhost` preview is refused by
// its SSRF guard, so local development gets no thumbnails (FAKE_SITE_INTEL draws placeholders instead). The renderer
// (BF-036) must let intel's user agent read previews even though they are `noindex`.
@Injectable()
export class IntelSiteScreenshotter implements SiteScreenshotter {
  constructor(private readonly intel: IntelClient) {}

  async capture(url: string, artifactPrefix: string, signal: AbortSignal) {
    const body = SiteIntelRequestSchema.parse({
      url,
      artifactPrefix,
      maxPages: 1,
      screenshots: { desktop: true, mobile: true, fullPage: false },
      timeoutSeconds: CAPTURE_SECONDS,
    });
    try {
      const result = await this.intel.post('/v1/site-intel', body, SiteIntelSchema, {
        policy: 'intel-site',
        signal,
      });
      return { desktopKey: result.screenshots.desktopKey, mobileKey: result.screenshots.mobileKey };
    } catch (error) {
      if (error instanceof BrokenCircuitError)
        throw new ExternalServiceError('intel', 'Screenshots are unavailable', {
          details: { reason: 'circuit_open', retryable: true },
        });
      throw error;
    }
  }
}

/** Plain placeholder pictures written to the artifacts bucket (tests and E2E with `FAKE_SITE_INTEL`). */
export class FakeSiteScreenshotter implements SiteScreenshotter {
  constructor(private readonly artifacts: ObjectStorage) {}

  async capture(_url: string, artifactPrefix: string) {
    const picture = (width: number, height: number) =>
      sharp({ create: { width, height, channels: 3, background: '#0f766e' } })
        .png()
        .toBuffer();
    const desktopKey = `${artifactPrefix}/desktop.png`;
    const mobileKey = `${artifactPrefix}/mobile.png`;
    await this.artifacts.put(desktopKey, await picture(64, 40), 'image/png');
    await this.artifacts.put(mobileKey, await picture(30, 64), 'image/png');
    return { desktopKey, mobileKey };
  }
}
