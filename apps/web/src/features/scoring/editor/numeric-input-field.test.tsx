import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NumericInput } from './numeric-input.tsx';

const field = (value: number, props: { min?: number; max?: number } = {}) => {
  const onCommit = vi.fn();
  const view = render(<NumericInput aria-label="Weight" value={value} onCommit={onCommit} {...props} />);
  return { onCommit, input: screen.getByRole('textbox', { name: 'Weight' }), view };
};

describe('NumericInput', () => {
  it('commits a value past its bound clamped', () => {
    const { onCommit, input } = field(100, { min: -100, max: 100 });
    fireEvent.change(input, { target: { value: '150' } });
    expect(onCommit).toHaveBeenCalledWith(100);
    // Already at the bound: leaving the field shows what the draft holds.
    fireEvent.blur(input);
    expect(input).toHaveValue('100');
  });

  it('keeps an unfinished value aside and restores the draft value on leaving', () => {
    const { onCommit, input } = field(12);
    fireEvent.change(input, { target: { value: '-' } });
    expect(onCommit).not.toHaveBeenCalled();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    fireEvent.blur(input);
    expect(input).toHaveValue('12');
  });

  it('keeps a typed decimal comma once committed', () => {
    const onCommit = vi.fn();
    const { rerender } = render(<NumericInput aria-label="Measure" value={0} onCommit={onCommit} />);
    const input = screen.getByRole('textbox', { name: 'Measure' });
    fireEvent.change(input, { target: { value: '0,5' } });
    expect(onCommit).toHaveBeenCalledWith(0.5);
    rerender(<NumericInput aria-label="Measure" value={0.5} onCommit={onCommit} />);
    fireEvent.blur(input);
    expect(input).toHaveValue('0,5');
  });

  it('follows a value changed from outside', () => {
    const onCommit = vi.fn();
    const { rerender } = render(<NumericInput aria-label="Weight" value={10} onCommit={onCommit} />);
    rerender(<NumericInput aria-label="Weight" value={-30} onCommit={onCommit} />);
    expect(screen.getByRole('textbox', { name: 'Weight' })).toHaveValue('-30');
  });
});
