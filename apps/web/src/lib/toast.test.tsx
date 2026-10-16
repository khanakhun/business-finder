import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { getToast, ToastHost } from './toast.tsx';

describe('ToastHost', () => {
  it('renders nothing until the first toast, then shows it', async () => {
    const { container } = render(<ToastHost />);
    expect(container).toBeEmptyDOMElement();

    // Not awaited inside act(): the host has to render before getToast() resolves.
    const shown = getToast().then((toast) => toast('Saved'));

    // The toaster is imported on first use: under a loaded machine (the whole verify in parallel) that can take
    // longer than findByText's default second.
    expect(await screen.findByText('Saved', undefined, { timeout: 5_000 })).toBeInTheDocument();
    await shown;
  });
});
