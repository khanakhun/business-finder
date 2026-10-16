import { blPack } from './bl-pack.ts';
import { nlPc4Pack, usZctaPack } from './national-packs.ts';
import type { GeoPack } from './types.ts';

export const GEO_PACKS: Readonly<Record<string, GeoPack>> = {
  [blPack.name]: blPack,
  [nlPc4Pack.name]: nlPc4Pack,
  [usZctaPack.name]: usZctaPack,
};
export { type ImportReport, importPack, type PackOptions } from './types.ts';
