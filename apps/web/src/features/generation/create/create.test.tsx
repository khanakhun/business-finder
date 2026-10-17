import type { GenerationEngineListing } from '@bf/contracts';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import en from '../../../i18n/messages/en.json';
import { AssignEngines } from './assign-engines.tsx';
import { useEngineHint } from './engine-select.tsx';
import { EstimatePanel } from './estimate-panel.tsx';

// The create flow's pieces (BF-046): engine hints for every state, the assign helper's preview and result, and the
// estimate as displayed.

const listing: GenerationEngineListing = {
  items: [
    {
      id: 'blocks',
      available: true,
      queued: 0,
      running: 0,
      capabilities: {
        sandboxed: false,
        supportsRepair: true,
        supportsChatEdit: true,
        maxParallel: 8,
        typicalCostUsd: 0.12,
        typicalDurationSec: 45,
      },
    },
    {
      id: 'claude-code',
      available: true,
      queued: 3,
      running: 2,
      capabilities: {
        sandboxed: true,
        supportsRepair: true,
        supportsChatEdit: false,
        maxParallel: 4,
        typicalCostUsd: 1.5,
        typicalDurationSec: 600,
      },
    },
    {
      id: 'codex',
      available: false,
      queued: 0,
      running: 0,
      capabilities: {
        sandboxed: true,
        supportsRepair: true,
        supportsChatEdit: false,
        maxParallel: 4,
        typicalCostUsd: 1.5,
        typicalDurationSec: 600,
      },
    },
  ],
};

const wrap = (node: React.ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {node}
    </NextIntlClientProvider>,
  );

function Hints() {
  const hint = useEngineHint();
  return (
    <ul>
      {(['auto', 'claude-code', 'codex', 'claude-agent-sdk'] as const).map((engine) => (
        <li key={engine}>{hint(engine, listing)}</li>
      ))}
    </ul>
  );
}

describe('create sites', () => {
  it('hints each engine: cost, time and load when available, why when not', () => {
    wrap(<Hints />);
    const items = screen.getAllByRole('listitem').map((item) => item.textContent);
    expect(items).toEqual([
      'The best available engine for each business',
      '~$1.50 · ~10 min · 2 running · 3 waiting',
      'Not available for this workspace (model key or settings)',
      'Not enabled on this deployment',
    ]);
  });

  it('previews and applies an assignment pattern by position', () => {
    const onApply = vi.fn();
    wrap(<AssignEngines count={6} onApply={onApply} />);
    fireEvent.click(screen.getByRole('button', { name: 'Assign engines…' }));
    const input = screen.getByLabelText('Pattern');
    fireEvent.change(input, { target: { value: 'two codex' } });
    expect(screen.getByText('This pattern cannot be read.')).toBeTruthy();
    fireEvent.change(input, { target: { value: '2 Claude Code + 2 Codex + rest Blocks' } });
    expect(screen.getByText('2 × Claude Code · 2 × Codex · 2 × Blocks')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onApply).toHaveBeenCalledWith([
      'claude-code',
      'claude-code',
      'codex',
      'codex',
      'blocks',
      'blocks',
    ]);
  });

  it('shows the estimate for the run mode', () => {
    const { rerender } = wrap(
      <EstimatePanel engines={['claude-code', 'blocks', 'auto']} listing={listing} maxParallel={1} />,
    );
    expect(screen.getByTestId('estimate-cost').textContent).toBe('$1.74');
    expect(screen.getByTestId('estimate-eta').textContent).toBe('~12 minutes');
    expect(screen.getByText(/3 jobs are already waiting/)).toBeTruthy();
    rerender(
      <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
        <EstimatePanel engines={['claude-code', 'blocks', 'auto']} listing={listing} maxParallel={3} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByTestId('estimate-eta').textContent).toBe('~10 minutes');
  });
});
