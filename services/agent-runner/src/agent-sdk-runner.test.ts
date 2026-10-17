import { describe, expect, it } from 'vitest';
import { insideWorkspace, SDK_DISALLOWED, SDK_TOOLS, workspaceGuard } from './agent-sdk-runner.ts';

// The Agent SDK runner's policy (BF-044): the tool set has no shell or web, and the PreToolUse hook refuses any path
// that leaves the workspace (relative or absolute, with `..`), letting every other call on to the permission rules.

const hook = (toolName: string, toolInput: unknown) => ({
  hook_event_name: 'PreToolUse' as const,
  tool_name: toolName,
  tool_input: toolInput,
  tool_use_id: 't1',
  session_id: 's',
  transcript_path: '',
  cwd: '/workspace',
});

describe('agent-sdk-runner policy', () => {
  it('resolves paths against the workspace and refuses those that leave it', () => {
    expect(insideWorkspace('/workspace', 'site.json')).toBe(true);
    expect(insideWorkspace('/workspace', '/workspace/.sitekit/x.png')).toBe(true);
    expect(insideWorkspace('/workspace', '/workspace')).toBe(true);
    expect(insideWorkspace('/workspace', '../etc/passwd')).toBe(false);
    expect(insideWorkspace('/workspace', '/workspace/../home/agent/.claude.json')).toBe(false);
    expect(insideWorkspace('/workspace', '/etc/hosts')).toBe(false);
    expect(insideWorkspace('/workspace', '/workspace-other/site.json')).toBe(false);
  });

  it('denies a file tool outside the workspace, logs it, and passes everything else on', async () => {
    const logged: string[] = [];
    const guard = workspaceGuard('/workspace', (line) => logged.push(line));
    const signal = new AbortController().signal;
    expect(
      await guard(hook('Read', { file_path: '/home/agent/.claude.json' }) as never, 't1', { signal }),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Only files inside the workspace may be read or written.',
      },
    });
    expect(logged).toEqual(['denied Read: /home/agent/.claude.json is outside the workspace']);
    expect(await guard(hook('Grep', { pattern: 'x', path: '../' }) as never, 't2', { signal })).toMatchObject(
      {
        hookSpecificOutput: { permissionDecision: 'deny' },
      },
    );
    // Inside the workspace, or no path: the normal rules decide (never an "allow" from the hook).
    expect(
      await guard(hook('Edit', { file_path: '/workspace/site.json' }) as never, 't3', { signal }),
    ).toEqual({});
    expect(await guard(hook('mcp__sitekit__validate_site', {}) as never, 't4', { signal })).toEqual({});
  });

  it('has file tools only: no shell, web, sub-agents or skills', () => {
    expect(SDK_TOOLS).toEqual(['Read', 'Edit', 'Write', 'Glob', 'Grep']);
    for (const tool of ['Bash', 'WebFetch', 'WebSearch', 'Task', 'Skill'])
      expect(SDK_DISALLOWED).toContain(tool);
  });
});
