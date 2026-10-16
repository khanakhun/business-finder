// @bf/sitekit (BF-042): the site toolbelt generation agents use — as a library, a CLI and an MCP server.
export {
  CONFIG_FILE,
  ConfigError,
  DEFAULT_LIMITS,
  limitsOf,
  loadConfig,
  type SitekitConfig,
  SitekitConfigSchema,
} from './lib/config.ts';
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
export { asSpec, readSiteRaw, SITE_FILE, writeSite } from './lib/site.ts';
export { parseFacts, pathString, type SitekitIssue, type ValidateInput, validate } from './lib/validate.ts';
export { MAX_READ_BYTES, Workspace, WorkspaceError } from './lib/workspace.ts';
