// Renders the eval's synthetic images (BF-038): shapes and gradients only, no third-party content. Run once with
// `node evals/assets.analyze_image/make-images.ts`; the JPEGs are committed.
import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const W = 1200;
const H = 800;
const svg = (body: string) =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${body}</svg>`);

const IMAGES: Record<string, string> = {
  // A sea horizon at sunset: landscape, no text, no people.
  'seascape-sunset': `<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f6a35b"/><stop offset="1" stop-color="#fbe3b5"/></linearGradient></defs><rect width="${W}" height="480" fill="url(#s)"/><rect y="480" width="${W}" height="320" fill="#2a6f97"/><circle cx="820" cy="470" r="70" fill="#fff3c4"/>`,
  // A shop sign with large lettering: contains text.
  'sign-open': `<rect width="${W}" height="${H}" fill="#e9e4da"/><rect x="250" y="250" width="700" height="300" rx="20" fill="#1d3557"/><text x="600" y="440" font-size="150" font-family="sans-serif" font-weight="bold" fill="#ffffff" text-anchor="middle">OUVERT</text>`,
  // A plain linen-like texture.
  'texture-linen': `<defs><pattern id="p" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill="#efe7d8"/><path d="M0 4h8M4 0v8" stroke="#e2d6c2" stroke-width="1"/></pattern></defs><rect width="${W}" height="${H}" fill="url(#p)"/>`,
  // A geometric logo: a monogram in a circle.
  'logo-monogram': `<rect width="${W}" height="${H}" fill="#ffffff"/><circle cx="600" cy="400" r="220" fill="#7a5c3e"/><text x="600" y="470" font-size="200" font-family="serif" fill="#ffffff" text-anchor="middle">SL</text>`,
  // A room: floor, wall, window and a table — a simple interior.
  'interior-room': `<rect width="${W}" height="${H}" fill="#f1ede6"/><rect y="560" width="${W}" height="240" fill="#b08968"/><rect x="760" y="120" width="300" height="320" fill="#a8dadc" stroke="#ffffff" stroke-width="16"/><rect x="200" y="460" width="360" height="30" fill="#5c4033"/><rect x="230" y="490" width="20" height="140" fill="#5c4033"/><rect x="510" y="490" width="20" height="140" fill="#5c4033"/>`,
  // Palm silhouettes on a beach: landscape.
  'beach-palms': `<rect width="${W}" height="${H}" fill="#9ad1e3"/><rect y="560" width="${W}" height="240" fill="#f2d8a7"/><rect x="300" y="300" width="18" height="280" fill="#3d2b1f" transform="rotate(-8 300 300)"/><ellipse cx="300" cy="300" rx="140" ry="40" fill="#2d6a4f"/>`,
};

for (const [name, body] of Object.entries(IMAGES)) {
  const jpeg = await sharp(svg(body)).jpeg({ quality: 85 }).toBuffer();
  await writeFile(new URL(`images/${name}.jpg`, import.meta.url), jpeg);
}
