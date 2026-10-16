import { resolve } from 'node:path';
import { OperationSchema } from '@bf/site-schema';
import { z } from 'zod';
import { OPERATION_NAMES } from '../lib/ops.ts';
import { UnknownBlockError } from '../lib/readers.ts';
import { Workspace, WorkspaceError } from '../lib/workspace.ts';
import { serveStdio } from '../mcp.ts';
import { runTool, type ToolResult } from '../tools.ts';
import { EXIT } from './output.ts';

// The `sitekit` CLI (BF-042): the same tools as the MCP server, for agents that work with a shell. `--json` prints one
// stable envelope (schemas/cli-output/); exit codes: 0 ok/done, 1 issues/not done, 2 usage, 3 internal error.

export const VERSION = '1.0.0';

interface Parsed {
  readonly command: string;
  readonly positional: string[];
  readonly flags: Map<string, string[]>;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

const BOOLEAN_FLAGS = new Set(['json', 'quiet', 'fix', 'full', 'version', 'help']);

export function parseArgs(argv: readonly string[]): Parsed {
  const flags = new Map<string, string[]>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
      if (BOOLEAN_FLAGS.has(name)) {
        flags.set(name, ['true']);
        continue;
      }
      const value = inline ?? argv[++i];
      if (value === undefined) throw new UsageError(`--${name} needs a value.`);
      flags.set(name, [...(flags.get(name) ?? []), value]);
    } else positional.push(arg);
  }
  const [command = flags.has('version') ? 'version' : 'help', ...rest] = positional;
  return { command, positional: rest, flags };
}

const one = (parsed: Parsed, name: string) => parsed.flags.get(name)?.at(-1);

export const HELP: Record<string, string> = {
  validate:
    'sitekit validate [--cwd <dir>] [--json]\n  Validate site.json (schema, rules, facts, limits). Exit 1 on errors.',
  'lint-copy':
    'sitekit lint-copy [--locale fr] [--fix] [--json]\n  Check the texts; --fix applies safe fixes (typography, spaces).\n  Example: sitekit lint-copy --locale fr --fix',
  ops: 'sitekit ops list | ops apply <file.json> | ops apply --json \'{"op":"updateText",…}\'\n  Apply operations to site.json, all or nothing.',
  diff: 'sitekit diff <from.json> [to.json]\n  What changed between two SiteSpec files (default to: site.json).',
  render:
    'sitekit render [--page <id>]… [--locale <xx>]…\n  Static HTML in .sitekit/render/ with a review index.',
  screenshot: 'sitekit screenshot --page <id> [--locale fr] [--viewport mobile|tablet|desktop] [--full]',
  catalog: 'sitekit catalog [block]\n  The block catalog (markdown and JSON Schema).',
  facts: 'sitekit facts [--kind phone] [--search gustavia]',
  assets: 'sitekit assets [--role logo|image]',
  check:
    'sitekit check [--json]\n  The definition of done. Exit 0 when done, 1 with the blocking items otherwise.',
  mcp: 'sitekit mcp\n  The MCP server (stdio) with the same tools.',
};

const GENERAL = `sitekit ${VERSION} — build and check a generated site from its workspace.

Commands: ${Object.keys(HELP).join(', ')}, help <command>, --version
Global flags: --cwd <workspace> (default .), --json (machine output), --quiet

Start with \`sitekit check\`; fix what it lists; repeat until "done".`;

interface Outcome {
  readonly exitCode: number;
  readonly data: unknown;
  readonly human: string;
  readonly error?: string;
}

function human(command: string, result: ToolResult): string {
  const data = result.data as Record<string, unknown>;
  const list = (items: unknown) =>
    (Array.isArray(items) ? items : [])
      .map((item) => {
        const issue = item as {
          severity?: string;
          at?: string;
          message?: string;
          hint?: string;
          rule?: string;
          code?: string;
        };
        const where = issue.at ? `${issue.at}: ` : '';
        return `${issue.severity ?? 'error'} ${issue.rule ?? issue.code ?? ''} ${where}${issue.message ?? ''}${issue.hint ? `\n  fix: ${issue.hint}` : ''}`;
      })
      .join('\n');
  switch (command) {
    case 'validate':
    case 'lint-copy':
      return `${list(data.issues)}\n${data.errors === 0 ? 'No errors.' : `${data.errors} error(s).`}${data.fixed ? ` ${data.fixed} fixed.` : ''}`.trim();
    case 'check': {
      const blocking = list(
        (data.blocking as { kind: string; at?: string; message: string; hint?: string }[]).map((item) => ({
          ...item,
          severity: item.kind,
        })),
      );
      return data.done ? `Done (${data.durationMs} ms).` : `Not done:\n${blocking}`;
    }
    default:
      return JSON.stringify(result.data, null, 2);
  }
}

async function readOperations(parsed: Parsed, workspace: Workspace): Promise<unknown> {
  const inline = one(parsed, 'json-ops') ?? one(parsed, 'op');
  if (inline) return JSON.parse(inline);
  const file = parsed.positional[1];
  if (!file) throw new UsageError("ops apply needs a file (inside the workspace) or --op '<json>'.");
  return workspace.readJson(file);
}

export async function run(argv: readonly string[]): Promise<Outcome> {
  let parsed: Parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    return {
      exitCode: EXIT.usage,
      data: null,
      human: (error as Error).message,
      error: (error as Error).message,
    };
  }
  const { command } = parsed;
  if (command === 'version') return { exitCode: EXIT.ok, data: { version: VERSION }, human: VERSION };
  if (command === 'help' || parsed.flags.has('help')) {
    const topic = command === 'help' ? parsed.positional[0] : command;
    const text = topic ? HELP[topic] : GENERAL;
    if (!text)
      return {
        exitCode: EXIT.usage,
        data: null,
        human: `Unknown command "${topic}".\n\n${GENERAL}`,
        error: `Unknown command "${topic}"`,
      };
    return { exitCode: EXIT.ok, data: { help: text }, human: text };
  }
  try {
    // `pnpm sitekit …` runs in the package folder: paths are the caller's (INIT_CWD), as typed.
    const base = process.env.INIT_CWD ?? process.cwd();
    const workspace = await Workspace.open(resolve(base, one(parsed, 'cwd') ?? '.'));
    const context = { workspace };
    let result: ToolResult;
    switch (command) {
      case 'validate':
        result = await runTool(context, 'validate_site', {});
        break;
      case 'lint-copy':
        result = await runTool(context, 'lint_copy', {
          ...(one(parsed, 'locale') ? { locale: one(parsed, 'locale') } : {}),
          fix: parsed.flags.has('fix'),
        });
        break;
      case 'ops': {
        const sub = parsed.positional[0];
        if (sub === 'list') {
          const schema = z.toJSONSchema(OperationSchema, {
            target: 'draft-2020-12',
            io: 'input',
            unrepresentable: 'any',
          });
          return {
            exitCode: EXIT.ok,
            data: { operations: OPERATION_NAMES, schema },
            human: `Operations: ${OPERATION_NAMES.join(', ')}\n(--json for their JSON Schema)`,
          };
        }
        if (sub !== 'apply') throw new UsageError('Use `sitekit ops list` or `sitekit ops apply …`.');
        result = await runTool(context, 'apply_operations', {
          operations: await readOperations(parsed, workspace),
        });
        break;
      }
      case 'diff': {
        const [from, to] = parsed.positional;
        if (!from) throw new UsageError('diff needs a file to compare: sitekit diff <from.json> [to.json].');
        result = await runTool(context, 'diff_site', { from, ...(to ? { to } : {}) });
        break;
      }
      case 'render':
        result = await runTool(context, 'render_pages', {
          ...(parsed.flags.get('page') ? { pages: parsed.flags.get('page') } : {}),
          ...(parsed.flags.get('locale') ? { locales: parsed.flags.get('locale') } : {}),
        });
        break;
      case 'screenshot': {
        const page = one(parsed, 'page');
        if (!page) throw new UsageError('screenshot needs --page <id>.');
        result = await runTool(context, 'screenshot_page', {
          page,
          ...(one(parsed, 'locale') ? { locale: one(parsed, 'locale') } : {}),
          ...(one(parsed, 'viewport') ? { viewport: one(parsed, 'viewport') } : {}),
          fullPage: parsed.flags.has('full'),
        });
        // The PNG is on disk (its path is in the output); a terminal does not need its bytes.
        result = { data: result.data, isError: result.isError };
        break;
      }
      case 'catalog':
        result = await runTool(
          context,
          'get_catalog',
          parsed.positional[0] ? { block: parsed.positional[0] } : {},
        );
        break;
      case 'facts':
        result = await runTool(context, 'get_facts', {
          ...(one(parsed, 'kind') ? { kind: one(parsed, 'kind') } : {}),
          ...(one(parsed, 'search') ? { search: one(parsed, 'search') } : {}),
        });
        break;
      case 'assets':
        result = await runTool(
          context,
          'list_assets',
          one(parsed, 'role') ? { role: one(parsed, 'role') } : {},
        );
        break;
      case 'check':
        result = await runTool(context, 'check_done', {});
        break;
      case 'mcp':
        await serveStdio(workspace);
        return { exitCode: -1, data: null, human: '' };
      default:
        throw new UsageError(`Unknown command "${command}". Commands: ${Object.keys(HELP).join(', ')}.`);
    }
    const data = result.data as { message?: string };
    const invalidInput =
      result.isError && typeof data?.message === 'string' && data.message.startsWith('Invalid input');
    return {
      exitCode: invalidInput ? EXIT.usage : result.isError ? EXIT.issues : EXIT.ok,
      data: result.data,
      human: human(command, result),
      ...(invalidInput ? { error: data.message } : {}),
    };
  } catch (error) {
    if (error instanceof UsageError)
      return { exitCode: EXIT.usage, data: null, human: error.message, error: error.message };
    if (
      error instanceof WorkspaceError ||
      error instanceof SyntaxError ||
      error instanceof UnknownBlockError
    ) {
      const message = error.message;
      return { exitCode: EXIT.usage, data: null, human: message, error: message };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      exitCode: EXIT.internal,
      data: null,
      human: `sitekit internal error: ${message}`,
      error: message,
    };
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const outcome = await run(argv);
  if (outcome.exitCode === -1) return; // the MCP server keeps the process alive
  const parsed = (() => {
    try {
      return parseArgs(argv);
    } catch {
      return undefined;
    }
  })();
  const json = parsed?.flags.has('json');
  if (json)
    process.stdout.write(
      `${JSON.stringify({
        command: parsed?.command ?? '',
        ok: outcome.exitCode === EXIT.ok,
        exitCode: outcome.exitCode,
        data: outcome.data,
        ...(outcome.error ? { error: outcome.error } : {}),
      })}\n`,
    );
  else if (!parsed?.flags.has('quiet') || outcome.exitCode !== EXIT.ok)
    (outcome.exitCode >= EXIT.usage ? process.stderr : process.stdout).write(`${outcome.human}\n`);
  process.exitCode = outcome.exitCode;
}
