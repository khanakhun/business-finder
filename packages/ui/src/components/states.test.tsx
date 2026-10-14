import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EmptyState } from './empty-state.tsx';
import { ErrorState } from './error-state.tsx';
import { formatShortcut, KeyboardShortcut } from './keyboard-shortcut.tsx';
import { PageHeader } from './page-header.tsx';

const labels = {
  retry: 'Try again',
  reference: 'Reference',
  copyReference: 'Copy reference',
  copied: 'Copied',
};

describe('ErrorState', () => {
  it('shows the problem title, detail and trace id', () => {
    render(
      <ErrorState
        problem={{ title: 'Not found', detail: 'No business with id b1.', traceId: '4bf92f35' }}
        labels={labels}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Not found');
    expect(screen.getByText('No business with id b1.')).toBeInTheDocument();
    expect(screen.getByTestId('trace-id')).toHaveTextContent('4bf92f35');
  });

  it('offers retry and copying the reference', async () => {
    const onRetry = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<ErrorState problem={{ title: 'Failed', traceId: 'abc' }} labels={labels} onRetry={onRetry} />);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole('button', { name: 'Copy reference' }));
    expect(writeText).toHaveBeenCalledWith('abc');
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('omits what the problem does not have', () => {
    render(<ErrorState problem={{ title: 'Failed' }} labels={labels} />);
    expect(screen.queryByTestId('trace-id')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('EmptyState and PageHeader', () => {
  it('render their content', () => {
    render(
      <>
        <PageHeader
          title="Pipeline"
          description="Businesses you are working with."
          actions={<button type="button">New</button>}
        />
        <EmptyState
          icon={<svg />}
          title="No businesses yet"
          description="Run a search to find some."
          action={<button type="button">Search</button>}
        />
      </>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Pipeline' })).toBeInTheDocument();
    expect(screen.getByText('Run a search to find some.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Search' })).toBeInTheDocument();
  });
});

describe('keyboard shortcuts', () => {
  it('formats modifiers per platform', () => {
    expect(formatShortcut(['mod', 'k'], true)).toEqual(['⌘', 'K']);
    expect(formatShortcut(['mod', 'shift', 'alt', 'Enter'], false)).toEqual([
      'Ctrl',
      'Shift',
      'Alt',
      'Enter',
    ]);
    expect(formatShortcut(['shift', 'alt'], true)).toEqual(['⇧', '⌥']);
  });

  it('renders keys as kbd elements', () => {
    const { container } = render(<KeyboardShortcut keys={['?']} />);
    expect(container.querySelectorAll('kbd')).toHaveLength(1);
  });
});
