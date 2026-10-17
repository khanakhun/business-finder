import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { SiteSpec } from '@bf/site-schema';
import { referencedAssetUrls, renderSite, Workspace } from '@bf/sitekit';
import { Inject, Injectable } from '@nestjs/common';
import { zipSync } from 'fflate';
import type { StaticExporter } from '../../application/go-live/export.service.ts';
import { SITE_HOSTING, type SiteHosting } from '../../application/ports.ts';

// The static export (BF-062): every page in every language rendered with the BF-034 static renderer (through
// sitekit, as the quality sandbox does), the stylesheet and fonts, the site's own images copied from the CDN into
// `assets/` (links rewritten), a README, zipped. Hotlinked stock images stay hotlinked (their licences ask for it)
// and keep their credits. Only the validated spec is rendered: no agent or crawled code runs here.

const FETCH_TIMEOUT_MS = 15_000;
const MAX_ASSET_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 300 * 1024 * 1024;
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

const README = (name: string, hotlinked: number) => `# ${name} — static website

## English

This folder is the complete website as static files: every page in every language, its stylesheet, fonts and images.

- Host it at the **root of a domain** (links are absolute: \`/styles.css\`, \`/en/…\`). Any static host works
  (a web server, object storage with a CDN, Netlify, GitHub Pages…).
- Images are in \`assets/\`.${hotlinked ? ` ${hotlinked} stock image(s) stay linked to their provider, as their licence asks; keep the photo credits shown on the pages.` : ''}
- The contact form sent its messages through the agency's platform: after a move it needs a new form service
  (or replace it with your email address and phone number).
- The legal notice and privacy pages must stay accurate: update them if the publisher, host or contact changes.

## Français

Ce dossier contient le site complet en fichiers statiques : toutes les pages dans toutes les langues, la feuille
de style, les polices et les images.

- Hébergez-le à la **racine d’un domaine** (les liens sont absolus : \`/styles.css\`, \`/en/…\`). Tout hébergement
  statique convient (serveur web, stockage objet avec CDN, Netlify, GitHub Pages…).
- Les images sont dans \`assets/\`.${hotlinked ? ` ${hotlinked} image(s) de banque d’images restent liées à leur fournisseur, comme leur licence le demande ; conservez les crédits photo affichés sur les pages.` : ''}
- Le formulaire de contact passait par la plateforme de l’agence : après un déménagement, il faut un nouveau
  service de formulaire (ou le remplacer par votre adresse e-mail et votre téléphone).
- Les mentions légales et la politique de confidentialité doivent rester exactes : mettez-les à jour si l’éditeur,
  l’hébergeur ou le contact change.
`;

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

@Injectable()
export class SitekitStaticExporter implements StaticExporter {
  constructor(@Inject(SITE_HOSTING) private readonly hosting: SiteHosting) {}

  async export(spec: SiteSpec, signal?: AbortSignal): Promise<{ zip: Buffer; files: number }> {
    const root = await mkdtemp(join(tmpdir(), 'bf-export-'));
    try {
      const workspace = await Workspace.open(root);
      await renderSite(workspace, spec, { outDir: 'site' });
      const site = join(root, 'site');
      await rm(join(site, '_review.html'), { force: true });
      await rm(join(site, 'fonts', '.keep'), { force: true });

      // The site's own images: copied next to the pages, links rewritten. Stock images (other hosts) stay.
      const ownHosts = [...this.hosting.assetHosts];
      const own = referencedAssetUrls(spec, ownHosts);
      const hotlinked = referencedAssetUrls(spec, [...(this.hosting.hotlinkHosts ?? [])]).length;
      const rewrites = new Map<string, string>();
      let total = 0;
      for (const url of own) {
        const target = new URL(url);
        const segments = target.pathname.split('/').filter(Boolean);
        if (segments.length === 0 || !segments.every((segment) => SAFE_SEGMENT.test(segment))) continue;
        const response = await fetch(url, {
          signal: AbortSignal.any([AbortSignal.timeout(FETCH_TIMEOUT_MS), ...(signal ? [signal] : [])]),
          redirect: 'error',
        });
        if (!response.ok) continue;
        const body = Buffer.from(await response.arrayBuffer());
        if (body.byteLength > MAX_ASSET_BYTES) continue;
        total += body.byteLength;
        if (total > MAX_TOTAL_BYTES) throw new Error('The site’s images exceed the export size limit.');
        const path = ['assets', target.hostname, ...segments].join('/');
        await mkdir(dirname(join(site, path)), { recursive: true });
        await writeFile(join(site, path), body);
        rewrites.set(url, `/${path}`);
      }
      const files = await listFiles(site);
      const entries: Record<string, Uint8Array> = {};
      for (const file of files) {
        const name = relative(site, file).split('\\').join('/');
        let content: Buffer = await readFile(file);
        if (name.endsWith('.html') && rewrites.size > 0) {
          let html = content.toString('utf8');
          for (const [url, local] of rewrites) html = html.split(url).join(local);
          content = Buffer.from(html, 'utf8');
        }
        entries[name] = new Uint8Array(content);
      }
      entries['README.md'] = new TextEncoder().encode(README(spec.brand.name, hotlinked));
      const zip = Buffer.from(zipSync(entries, { level: 6, mtime: new Date('2000-01-01T00:00:00Z') }));
      return { zip, files: Object.keys(entries).length };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}
