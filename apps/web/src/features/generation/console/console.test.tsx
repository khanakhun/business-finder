import type { QualityReport } from '@bf/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { FileTextIcon, PencilIcon, ShieldCheckIcon, TerminalIcon, WrenchIcon } from 'lucide-react';
import { NextIntlClientProvider } from 'next-intl';
import type * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import en from '../../../i18n/messages/en.json';
import type { LoggedEvent } from './event-log.ts';
import { EventRow, toolIcon } from './event-renderers.tsx';
import { groupIssues, QualityTab } from './quality-tab.tsx';

// The console's renderers (BF-046): one per event type, untrusted text as text; the quality report grouped by page
// and section, with the rubric, the screenshots and the auto-fixes.

const report: QualityReport = {
  pipelineVersion: 1,
  candidateHash: 'a'.repeat(64),
  score: 62,
  decision: 'needs_review',
  infraError: false,
  gates: [
    { id: 'schema', status: 'pass', durationMs: 12, costUsd: 0, issues: [] },
    { id: 'copy', status: 'fail', durationMs: 40, costUsd: 0, issues: [] },
    {
      id: 'visual',
      status: 'pass',
      score: 70,
      durationMs: 9_000,
      costUsd: 0.02,
      issues: [],
      rubric: { hierarchy: 4, typography: 3 },
    },
  ],
  autoFixes: [
    {
      rule: 'typography.nbsp',
      path: 'pages[0].blocks[0].props.title.fr',
      before: 'Bonjour !',
      after: 'Bonjour !',
    },
  ],
  issues: [
    {
      gate: 'copy',
      code: 'copy.placeholder',
      severity: 'error',
      message: 'Replace the placeholder.',
      repairable: true,
      autoFixable: false,
      target: { pageId: 'home', blockId: 'hero' },
    },
    {
      gate: 'copy',
      code: 'copy.length',
      severity: 'warning',
      message: 'Shorten the tagline.',
      repairable: true,
      autoFixable: false,
      target: { pageId: 'home', blockId: 'hero' },
    },
    {
      gate: 'claims',
      code: 'claim.unsupported',
      severity: 'warning',
      message: 'Remove “best in town”.',
      repairable: true,
      autoFixable: false,
    },
  ],
  screenshots: [{ page: 'home', viewport: 'desktop', ref: 'generation/o/j/quality/x/home.desktop.png' }],
  createdAt: '2026-10-17T08:00:00.000Z',
};

vi.mock('../api.ts', () => ({
  useQuality: () => ({ isLoading: false, isError: false, data: { report } }),
}));
vi.mock('./screenshots.ts', () => ({
  fetchScreenshot: async () => new Blob(['png'], { type: 'image/png' }),
}));

const wrap = (node: React.ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
        {node}
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );

const at = '2026-10-17T08:00:00.000Z';
const events: LoggedEvent[] = [
  { seq: 1, type: 'status', phase: 'running', attempt: 1, at },
  { seq: 2, type: 'progress', pct: 40, label: 'Writing pages', attempt: 1, at },
  { seq: 3, type: 'log', level: 'warn', message: '<b>not markup</b>', attempt: 1, at },
  { seq: 4, type: 'tool_call', tool: 'sitekit validate', summary: '2 issues', attempt: 1, at },
  { seq: 5, type: 'file_change', path: 'site.json', attempt: 1, at },
  { seq: 6, type: 'usage', inputTokens: 1000, outputTokens: 200, costUsd: 0.0123, attempt: 1, at },
  { seq: 7, type: 'artifact', kind: 'screenshot', ref: 'x', attempt: 1, at },
  { seq: 8, type: 'error', code: 'TIMEOUT', message: 'Run timed out', retryable: true, attempt: 1, at },
  { seq: 9, type: 'done', siteSpecRef: 'x', attempt: 1, at },
];

describe('event renderers', () => {
  it('renders every event type, agent text as plain text', () => {
    const { container } = wrap(
      <ul>
        {events.map((event) => (
          <li key={event.seq}>
            <EventRow event={event} />
          </li>
        ))}
      </ul>,
    );
    const lines = [...container.querySelectorAll('li')].map((item) => item.textContent);
    expect(lines).toEqual([
      'Running',
      '40% · Writing pages',
      '<b>not markup</b>',
      'sitekit validate 2 issues',
      'site.json',
      '1,200 tokens · $0.0123',
      'Screenshot taken',
      'TIMEOUT Run timed outThe run took longer than its time limit. It will be retried.',
      'Site ready',
    ]);
    expect(container.querySelector('b')).toBeNull();
  });

  it('picks an icon per tool', () => {
    expect(toolIcon('sitekit validate')).toBe(ShieldCheckIcon);
    expect(toolIcon('Read')).toBe(FileTextIcon);
    expect(toolIcon('Edit')).toBe(PencilIcon);
    expect(toolIcon('Bash')).toBe(TerminalIcon);
    expect(toolIcon('mystery')).toBe(WrenchIcon);
  });
});

describe('quality tab', () => {
  it('groups issues: site-wide first, then by page and section', () => {
    expect(
      groupIssues(report.issues).map((group) => [group.pageId, group.blockId, group.issues.length]),
    ).toEqual([
      [null, null, 1],
      ['home', 'hero', 2],
    ]);
  });

  it('shows the score, the gates, the issues with editor links, the rubric, screenshots and fixes', async () => {
    wrap(<QualityTab jobId="job-1" siteId="site-1" />);
    expect(screen.getByTestId('quality-score').textContent).toBe('62');
    expect(screen.getByText('Needs review')).toBeTruthy();
    expect(screen.getByText('3 issues')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open in the editor' }).getAttribute('href')).toBe(
      '/sites/site-1/edit?page=home',
    );
    expect(screen.getByText('Hierarchy')).toBeTruthy();
    expect(screen.getByText('4/5')).toBeTruthy();
    expect(screen.getByText('1 automatic fix')).toBeTruthy();
    expect(await screen.findByRole('img', { name: 'home, desktop' })).toBeTruthy();
  });
});
