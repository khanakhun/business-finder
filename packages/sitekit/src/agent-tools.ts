import type { z } from 'zod';
import type { Workspace } from './lib/workspace.ts';
import { toCallToolResult } from './mcp.ts';
import { SITEKIT_TOOLS, type SitekitTool, type ToolContext } from './tools.ts';

// In-process tools for the Claude Agent SDK engine (BF-042 → BF-044). The SDK is the caller's dependency: pass its
// `tool` function (`import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'`) and hand the result
// to `createSdkMcpServer({ name: 'sitekit', tools })`. The handlers are the MCP server's: same tools, same results.

type CallToolResult = ReturnType<typeof toCallToolResult>;

/** The Agent SDK's `tool(name, description, inputSchema, handler, extras?)` (shape we rely on). */
export type AgentToolFactory<T> = (
  name: string,
  description: string,
  inputSchema: z.ZodRawShape,
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<CallToolResult>,
  extras?: { annotations?: SitekitTool['annotations'] },
) => T;

export function createSitekitAgentTools<T>(
  workspace: Workspace,
  tool: AgentToolFactory<T>,
  context: Omit<ToolContext, 'workspace'> = {},
): T[] {
  return (SITEKIT_TOOLS as readonly SitekitTool[]).map((definition) =>
    tool(
      definition.name,
      definition.description,
      definition.inputSchema,
      async (args) => {
        try {
          return toCallToolResult(await definition.run({ ...context, workspace }, args as never));
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: `sitekit error: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      },
      { annotations: definition.annotations },
    ),
  );
}
