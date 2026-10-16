import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { type PagePlanTemplate, PagePlanTemplateSchema } from '../domain/brief/page-plan.ts';

// The page plan templates (`page-plans/*.yaml`, BF-040), read and validated once: a malformed file fails at start.

const DIR = fileURLToPath(new URL('./page-plans/', import.meta.url));

export function loadPagePlans(dir = DIR): PagePlanTemplate[] {
  const templates = readdirSync(dir)
    .filter((name) => name.endsWith('.yaml'))
    .sort()
    .map((name) => {
      const parsed = PagePlanTemplateSchema.safeParse(parse(readFileSync(join(dir, name), 'utf8')));
      if (!parsed.success) throw new Error(`Page plan ${name} is invalid: ${parsed.error.message}`);
      return parsed.data;
    });
  const ids = templates.map((template) => template.id);
  if (new Set(ids).size !== ids.length) throw new Error('Page plan ids must be unique');
  if (!templates.some((template) => template.match.includes('default')))
    throw new Error('No default page plan');
  return templates;
}

let cached: PagePlanTemplate[] | undefined;
export const pagePlans = (): PagePlanTemplate[] => {
  cached ??= loadPagePlans();
  return cached;
};
