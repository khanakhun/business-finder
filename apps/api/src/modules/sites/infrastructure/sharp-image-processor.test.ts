import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { SharpImageProcessor } from './sharp-image-processor.ts';

const picture = (format: 'jpeg' | 'gif' | 'tiff' | 'png') =>
  sharp({ create: { width: 40, height: 20, channels: 3, background: '#0f766e' } })
    .toFormat(format)
    .toBuffer();

describe('SharpImageProcessor', () => {
  const images = new SharpImageProcessor();

  it('reads the accepted types and refuses any other the decoder knows (GIF, TIFF)', async () => {
    expect(await images.inspect(await picture('jpeg'))).toEqual({ width: 40, height: 20 });
    expect(await images.inspect(await picture('png'))).toEqual({ width: 40, height: 20 });
    await expect(images.inspect(await picture('gif'))).rejects.toThrow(/Unsupported image format/);
    await expect(images.variants(await picture('tiff'), [40])).rejects.toThrow(/Unsupported image format/);
  });

  it('re-encodes without metadata and never enlarges', async () => {
    const tagged = await sharp(await picture('jpeg'))
      .withMetadata({ exif: { IFD0: { Copyright: 'Someone' } } })
      .jpeg()
      .toBuffer();
    const variants = await images.variants(tagged, [480]);
    expect(variants.map((variant) => `${variant.width}.${variant.format}`)).toEqual(['40.webp', '40.avif']);
    expect((await sharp(variants[0]?.body).metadata()).exif).toBeUndefined();
  });
});
