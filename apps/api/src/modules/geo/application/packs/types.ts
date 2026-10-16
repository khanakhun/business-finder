import type { GeoAreaInput, GeoAreaRepository } from '../ports.ts';

/** An importable set of areas (BF-017). Idempotent: areas upsert by (source, source_ref). */
export interface GeoPack {
  readonly name: string;
  /** Where the data comes from and under which licence (shown by `pnpm geo:import --list`). */
  readonly source: string;
  areas(options: PackOptions): AsyncIterable<GeoAreaInput>;
}

export interface PackOptions {
  /** Input file for packs built from large downloads (GeoJSON Text Sequence, one feature per line). */
  readonly file?: string;
  /** US ZCTA: keep only ZIP codes starting with these digits (e.g. `33` for Miami-Dade). */
  readonly prefix?: string;
}

export interface ImportReport {
  readonly pack: string;
  readonly written: number;
  readonly unchanged: number;
}

export async function importPack(
  pack: GeoPack,
  repository: GeoAreaRepository,
  options: PackOptions = {},
): Promise<ImportReport> {
  let written = 0;
  let unchanged = 0;
  for await (const area of pack.areas(options)) {
    const { changed } = await repository.upsert(area);
    if (changed) written++;
    else unchanged++;
  }
  return { pack: pack.name, written, unchanged };
}
