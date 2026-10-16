import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SharpImageProcessor } from '../sharp-image-processor.ts';
import { monogramSvg, wordmarkSvg } from './wordmark.ts';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');

describe('wordmark', () => {
  it('outlines the name to paths, the same bytes every time', () => {
    const a = wordmarkSvg('Salon Lumière', { face: 'serif', color: '#7a5c3e' });
    const b = wordmarkSvg('Salon Lumière', { face: 'serif', color: '#7a5c3e' });
    expect(hash(a.svg)).toBe(hash(b.svg));
    expect(a.svg).toMatch(/^<svg [^>]+><path fill="#7a5c3e" d="M[^"]+"\/><\/svg>$/);
    expect(a.svg).not.toContain('<text');
    expect(a.width).toBeGreaterThan(a.height * 3);
    // Another face, another drawing.
    expect(wordmarkSvg('Salon Lumière', { face: 'sans', color: '#7a5c3e' }).svg).not.toBe(a.svg);
  });

  it('never lets the name or a colour reach the markup unescaped', () => {
    const svg = wordmarkSvg('<script>alert(1)</script> & "Co"', { face: 'sans', color: '"/><script>' }).svg;
    expect(svg).not.toMatch(/<script|alert\(|&|"Co"/);
    expect(svg).toContain('fill="#1f2937"');
    // Nothing drawable left: a placeholder dot, never an empty drawing.
    expect(wordmarkSvg('東京', { face: 'serif', color: '#000000' }).svg).toContain('d="M');
  });

  it('draws initials in a circle for the favicon, rasterized as a PNG', async () => {
    const mono = monogramSvg('Salon Lumière', { face: 'sans', color: '#ffffff', background: '#7a5c3e' });
    expect(mono.svg).toContain('<circle cx="256" cy="256" r="256" fill="#7a5c3e"/>');
    const png = await new SharpImageProcessor().rasterizeSvg(mono.svg, 128);
    expect(png.subarray(1, 4).toString()).toBe('PNG');
  });
});
