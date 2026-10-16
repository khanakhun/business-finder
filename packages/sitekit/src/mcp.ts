import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Workspace } from './lib/workspace.ts';
import { SITEKIT_TOOLS, type SitekitTool, type ToolContext, type ToolResult } from './tools.ts';

// `sitekit mcp` (BF-042): the tools over the Model Context Protocol (stdio). Inputs are the tools' Zod shapes,
// results their JSON (and a PNG for screenshots); a tool that finds problems answers with `isError`, a crash too.

export const SERVER_INFO = { name: 'sitekit', version: '1.0.0' } as const;

export function toCallToolResult(result: ToolResult): CallToolResult {
  return {
    content: [
      { type: 'text', text: JSON.stringify(result.data, null, 2) },
      ...(result.image
        ? [{ type: 'image' as const, data: result.image.data, mimeType: result.image.mimeType }]
        : []),
    ],
    isError: result.isError,
  };
}

async function guarded(run: () => Promise<ToolResult>): Promise<CallToolResult> {
  try {
    return toCallToolResult(await run());
  } catch (error) {
    // Informative, never a stack: the agent can act on the message.
    return {
      content: [
        { type: 'text', text: `sitekit error: ${error instanceof Error ? error.message : String(error)}` },
      ],
      isError: true,
    };
  }
}

export function createSitekitMcpServer(
  workspace: Workspace,
  context: Omit<ToolContext, 'workspace'> = {},
): McpServer {
  const server = new McpServer(SERVER_INFO);
  for (const tool of SITEKIT_TOOLS as readonly SitekitTool[])
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      // biome-ignore lint/suspicious/noExplicitAny: the SDK infers each tool's argument type from its own shape.
      ((args: any) => guarded(() => tool.run({ ...context, workspace }, args))) as never,
    );
  return server;
}

export async function serveStdio(workspace: Workspace): Promise<void> {
  await createSitekitMcpServer(workspace).connect(new StdioServerTransport());
}
