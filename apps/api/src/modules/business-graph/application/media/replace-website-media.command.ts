import { Inject, Injectable } from '@nestjs/common';

/** A logo or content image a business's own website shows (an external URL; downloaded later by BF-038). */
export interface WebsiteMediaItem {
  readonly kind: 'logo' | 'photo' | 'og_image';
  readonly url: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly altText: string | null;
}

/** Port: the business's media that came from its website (replaced as a set). */
export interface WebsiteMediaRepository {
  replace(businessId: string, media: readonly WebsiteMediaItem[], locale: 'fr' | 'en'): Promise<void>;
}
export const WEBSITE_MEDIA_REPOSITORY = Symbol('WebsiteMediaRepository');

/**
 * Replaces the media a business's website showed (BF-027 site intel): external URLs only, licensed as the owner's
 * site. Media stored by other sources, and downloaded copies, are left alone.
 */
@Injectable()
export class ReplaceWebsiteMediaCommand {
  constructor(@Inject(WEBSITE_MEDIA_REPOSITORY) private readonly media: WebsiteMediaRepository) {}

  execute(businessId: string, media: readonly WebsiteMediaItem[], locale: 'fr' | 'en'): Promise<void> {
    return this.media.replace(
      businessId,
      media.filter((m) => /^https?:\/\//.test(m.url) && m.url.length <= 2_000).slice(0, 25),
      locale,
    );
  }
}
