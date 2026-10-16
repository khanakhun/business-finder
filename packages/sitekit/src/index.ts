// @bf/sitekit (BF-042): the site toolbelt generation agents use — as a library, a CLI and an MCP server.

export { type CheckItem, type CheckReport, check, SHOTS_DIR } from './lib/check.ts';
export {
  CONFIG_FILE,
  ConfigError,
  DEFAULT_LIMITS,
  limitsOf,
  loadConfig,
  type SitekitConfig,
  SitekitConfigSchema,
} from './lib/config.ts';
export {
  applyLintFixes,
  frenchTypography,
  LINT_RULES,
  type LintInput,
  type LintIssue,
  type LintRule,
  lintCopy,
  textFields,
  tidyWhitespace,
} from './lib/lint.ts';
export { type AppliedOps, applyOps, diff, parseOperations, summarize } from './lib/ops.ts';
export {
  ASSETS_FILE,
  assets,
  type CatalogBlock,
  catalog,
  FACTS_FILE,
  facts,
  readFacts,
  UnknownBlockError,
} from './lib/readers.ts';
export { RENDER_DIR, type RenderedPage, type RenderResult, renderSite } from './lib/render.ts';
export {
  type ScreenshotRequest,
  type Shooter,
  type Shot,
  screenshot,
  serveFolder,
  VIEWPORTS,
  type Viewport,
} from './lib/screenshot.ts';
export { asSpec, readSiteRaw, SITE_FILE, writeSite } from './lib/site.ts';
export { parseFacts, pathString, type SitekitIssue, type ValidateInput, validate } from './lib/validate.ts';
export { MAX_READ_BYTES, Workspace, WorkspaceError } from './lib/workspace.ts';
