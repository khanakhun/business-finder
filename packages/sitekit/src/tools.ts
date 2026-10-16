import { readFile } from 'node:fs/promises';
import { applyAndValidate, OperationError, SiteLocaleSchema, type SiteSpec } from '@bf/site-schema';
import { z } from 'zod';
import { check } from './lib/check.ts';
import { loadConfig } from './lib/config.ts';
import { applyLintFixes, lintCopy } from './lib/lint.ts';
import { diff, parseOperations } from './lib/ops.ts';
import { assets, catalog, facts, readFacts } from './lib/readers.ts';
import { RENDER_DIR, renderSite } from './lib/render.ts';
import { type Shooter, screenshot, VIEWPORTS } from './lib/screenshot.ts';
import { asSpec, readSiteRaw, SITE_FILE, writeSite } from './lib/site.ts';
import { validate } from './lib/validate.ts';
import type { Workspace } from './lib/workspace.ts';

// sitekit's tools (BF-042), defined once for the MCP server and the Agent SDK: Zod inputs, MCP annotations and one
// handler each. There is no generic file-write or shell tool: the site changes only through `apply_operations` (or
// the agent's own edits of site.json), and work is done when `check_done` says so.

export interface ToolResult {
  /** Machine-readable result (also sent as JSON text). */
  readonly data: unknown;
  /** Whether the tool found problems (validation errors, a failed check…), not whether it crashed. */
  readonly isError: boolean;
  /** A PNG to show the agent (screenshots). */
  readonly image?: { readonly data: string; readonly mimeType: 'image/png' };
}

export interface ToolContext {
  readonly workspace: Workspace;
  /** Screenshots (tests inject a stub). */
  readonly shooter?: Shooter;
}

export interface SitekitTool<S extends z.ZodRawShape = z.ZodRawShape> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: S;
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly idempotentHint?: boolean;
    readonly destructiveHint?: boolean;
  };
  run(context: ToolContext, args: z.infer<z.ZodObject<S>>): Promise<ToolResult>;
}

const define = <S extends z.ZodRawShape>(tool: SitekitTool<S>) => tool;

async function loaded(workspace: Workspace) {
  const config = await loadConfig(workspace);
  const raw = await readSiteRaw(workspace, config);
  const registry = await readFacts(workspace);
  return { config, raw, registry, spec: asSpec(raw.value) };
}

const errorsOf = (issues: readonly { severity: string }[]) =>
  issues.filter((issue) => issue.severity === 'error').length;

export const SITEKIT_TOOLS = [
  define({
    name: 'validate_site',
    title: 'Validate the site',
    description:
      'Validate site.json: the SiteSpec schema, the semantic rules, the facts (strict) and the limits. Each issue has its path and a fix hint.',
    inputSchema: {},
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run({ workspace }) {
      const { config, raw, registry } = await loaded(workspace);
      const issues = validate(raw.value, {
        config,
        bytes: raw.bytes,
        ...(registry ? { facts: registry } : {}),
      });
      return { data: { errors: errorsOf(issues), issues }, isError: errorsOf(issues) > 0 };
    },
  }),
  define({
    name: 'lint_copy',
    title: 'Lint the copy',
    description:
      'Check the texts: placeholders, clichés, unproven superlatives, numbers not in facts, wrong language, French typography, sentence length, duplicates, CTA verbs, SEO lengths, alt texts. `fix: true` applies the safe fixes (typography, spaces) to site.json.',
    inputSchema: {
      locale: SiteLocaleSchema.optional().describe('Only this locale.'),
      fix: z.boolean().default(false).describe('Apply the safe fixes to site.json.'),
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
    async run({ workspace }, args) {
      const { config, registry, spec } = await loaded(workspace);
      if (!spec)
        return {
          data: { message: 'site.json is not a valid SiteSpec: run validate_site first.' },
          isError: true,
        };
      const input = {
        config,
        ...(registry ? { facts: registry } : {}),
        ...(args.locale ? { locale: args.locale } : {}),
      };
      let issues = lintCopy(spec, input);
      let fixed = 0;
      if (args.fix) {
        const result = applyLintFixes(spec, issues);
        fixed = result.fixed;
        if (fixed > 0) {
          await writeSite(workspace, result.spec);
          issues = lintCopy(result.spec, input);
        }
      }
      return { data: { errors: errorsOf(issues), fixed, issues }, isError: errorsOf(issues) > 0 };
    },
  }),
  define({
    name: 'apply_operations',
    title: 'Apply operations',
    description:
      'Apply SiteSpec operations to site.json, all or nothing (one operation, a list, or {op:"batch",ops:[…]}). The result is validated; site.json is written only when it has no error. Returns the inverse to undo.',
    inputSchema: {
      operations: z
        .unknown()
        .describe(
          'One operation, a list of operations, or a batch (see get_catalog and the operations schema).',
        ),
    },
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false },
    async run({ workspace }, args) {
      const { config, registry, spec } = await loaded(workspace);
      if (!spec)
        return {
          data: { message: 'site.json is not a valid SiteSpec: run validate_site first.' },
          isError: true,
        };
      try {
        const operation = parseOperations(args.operations);
        const result = applyAndValidate(spec, operation, {
          assetHosts: config.assetHosts,
          hotlinkHosts: config.hotlinkHosts,
          ownDomains: config.ownDomains,
          mode: 'preview',
          // Without facts.json nothing can be stated: an empty registry flags every literal.
          registry: registry ?? { facts: [] },
        });
        const errors = result.issues.filter((issue) => issue.severity === 'error');
        if (errors.length > 0)
          return {
            data: { applied: false, message: 'Not applied: the result has errors.', issues: result.issues },
            isError: true,
          };
        await writeSite(workspace, result.spec);
        return { data: { applied: true, inverse: result.inverse, issues: result.issues }, isError: false };
      } catch (error) {
        if (error instanceof OperationError)
          return { data: { applied: false, code: error.code, message: error.message }, isError: true };
        throw error;
      }
    },
  }),
  define({
    name: 'diff_site',
    title: 'Diff two sites',
    description:
      'What changed between two SiteSpec files of the workspace (default: `from` against site.json).',
    inputSchema: {
      from: z.string().max(200).describe('A workspace JSON file, e.g. "site.starter.json".'),
      to: z.string().max(200).default(SITE_FILE).describe('Default site.json.'),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run({ workspace }, args) {
      const a = asSpec(await workspace.readJson(args.from));
      const b = asSpec(await workspace.readJson(args.to));
      if (!a || !b)
        return { data: { message: `${!a ? args.from : args.to} is not a valid SiteSpec.` }, isError: true };
      return { data: diff(a, b), isError: false };
    },
  }),
  define({
    name: 'render_pages',
    title: 'Render pages',
    description: `Render the site to static HTML in ${RENDER_DIR}/ (every page and locale by default), with a review index.`,
    inputSchema: {
      pages: z.array(z.string().max(32)).max(8).optional(),
      locales: z.array(SiteLocaleSchema).max(4).optional(),
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
    async run({ workspace }, args) {
      const { spec } = await loaded(workspace);
      if (!spec)
        return {
          data: { message: 'site.json is not a valid SiteSpec: run validate_site first.' },
          isError: true,
        };
      const result = await renderSite(workspace, spec, {
        ...(args.pages ? { pages: args.pages } : {}),
        ...(args.locales ? { locales: args.locales } : {}),
      });
      return { data: result, isError: false };
    },
  }),
  define({
    name: 'screenshot_page',
    title: 'Screenshot a page',
    description:
      'Render the site and photograph one page in Chromium (mobile, tablet or desktop). Returns the image and its path.',
    inputSchema: {
      page: z.string().max(32).describe('A page id, e.g. "home".'),
      locale: SiteLocaleSchema.optional().describe('Default: the site default locale.'),
      viewport: z.enum(Object.keys(VIEWPORTS) as ['mobile', 'tablet', 'desktop']).default('mobile'),
      fullPage: z.boolean().default(false),
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
    async run({ workspace, shooter }, args) {
      const { spec } = await loaded(workspace);
      if (!spec)
        return {
          data: { message: 'site.json is not a valid SiteSpec: run validate_site first.' },
          isError: true,
        };
      const site = spec as SiteSpec;
      await renderSite(workspace, site);
      const [shot] = await (shooter ?? screenshot)(
        workspace,
        site,
        RENDER_DIR,
        [
          {
            page: args.page,
            locale: args.locale ?? site.defaultLocale,
            viewport: args.viewport,
            fullPage: args.fullPage,
          },
        ],
        '.sitekit/screenshots',
      );
      if (!shot) return { data: { message: 'No screenshot was produced.' }, isError: true };
      const png = await readFile(await workspace.resolve(shot.file)).catch(() => undefined);
      return {
        data: shot,
        isError: false,
        ...(png && png.length > 0
          ? { image: { data: png.toString('base64'), mimeType: 'image/png' as const } }
          : {}),
      };
    },
  }),
  define({
    name: 'get_catalog',
    title: 'Block catalog',
    description:
      'The blocks a page can use: purpose, variants, markdown guide and JSON Schema (one block or all).',
    inputSchema: { block: z.string().max(40).optional().describe('A block type, e.g. "hero".') },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run(_context, args) {
      return { data: catalog(args.block ? { block: args.block } : {}), isError: false };
    },
  }),
  define({
    name: 'get_facts',
    title: 'Facts',
    description:
      'The facts the site may state (facts.json), filtered by kind and/or a search over their values.',
    inputSchema: { kind: z.string().max(40).optional(), search: z.string().max(100).optional() },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run({ workspace }, args) {
      return {
        data: await facts(workspace, {
          ...(args.kind ? { kind: args.kind } : {}),
          ...(args.search ? { search: args.search } : {}),
        }),
        isError: false,
      };
    },
  }),
  define({
    name: 'list_assets',
    title: 'Assets',
    description: 'The images the site may use (assets/assets.json), with their licences: the logo or photos.',
    inputSchema: { role: z.enum(['logo', 'image']).optional() },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run({ workspace }, args) {
      return { data: await assets(workspace, args.role ? { role: args.role } : {}), isError: false };
    },
  }),
  define({
    name: 'check_done',
    title: 'Check done',
    description:
      'The definition of done: zero validation errors (strict facts), zero copy errors, every page renders, home screenshots on mobile and desktop. Returns done, the blocking items and warnings.',
    inputSchema: {},
    annotations: { readOnlyHint: false, idempotentHint: true },
    async run({ workspace, shooter }) {
      const report = await check(workspace, shooter ? { shooter } : {});
      return { data: report, isError: !report.done };
    },
  }),
] as const;

export type SitekitToolName = (typeof SITEKIT_TOOLS)[number]['name'];

/** Runs a tool by name with raw arguments (validated against its schema). */
export async function runTool(context: ToolContext, name: string, args: unknown): Promise<ToolResult> {
  const tool = SITEKIT_TOOLS.find((candidate) => candidate.name === name) as SitekitTool | undefined;
  if (!tool) return { data: { message: `Unknown tool ${name}.` }, isError: true };
  const parsed = z.object(tool.inputSchema).safeParse(args ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      data: {
        message: `Invalid input${first?.path.length ? ` at ${first.path.join('.')}` : ''}: ${first?.message}`,
      },
      isError: true,
    };
  }
  return tool.run(context, parsed.data);
}
