import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { CategoryPicker, type CategoryPickerNode, flattenCategories } from './category-picker.tsx';

const TREE: CategoryPickerNode[] = [
  {
    id: 'shops',
    label: 'Commerces',
    children: [
      { id: 'hardware', label: 'Quincaillerie', keywords: ['hardware store', 'droguerie'], children: [] },
      { id: 'florist', label: 'Fleuriste', children: [] },
    ],
  },
  {
    id: 'food',
    label: 'Restauration',
    children: [{ id: 'cafe', label: 'Café', keywords: ['coffee shop'], children: [] }],
  },
];

const labels = {
  placeholder: 'Choose categories',
  searchPlaceholder: 'Search categories',
  emptyText: 'No category',
  remove: (label: string) => `Remove ${label}`,
  more: (n: number) => `+${n}`,
  selected: 'selected',
};

function Harness({ multiple = true, initial = [] as string[] }) {
  const [value, setValue] = React.useState<string[]>(initial);
  return (
    <>
      <CategoryPicker tree={TREE} value={value} onChange={setValue} labels={labels} multiple={multiple} />
      <output data-testid="value">{value.join(',')}</output>
    </>
  );
}

describe('CategoryPicker', () => {
  it('flattens the tree depth-first with trails', () => {
    expect(flattenCategories(TREE).map((n) => [n.id, n.depth, n.trail.join('/')])).toEqual([
      ['shops', 0, ''],
      ['hardware', 1, 'Commerces'],
      ['florist', 1, 'Commerces'],
      ['food', 0, ''],
      ['cafe', 1, 'Restauration'],
    ]);
  });

  it('searches labels and keywords without accents, and multi-selects', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('combobox'));
    await user.type(screen.getByPlaceholderText('Search categories'), 'hardware');
    expect(screen.getByRole('option', { name: /Quincaillerie/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Fleuriste/ })).not.toBeInTheDocument();
    await user.keyboard('{Enter}');
    await user.clear(screen.getByPlaceholderText('Search categories'));
    await user.type(screen.getByPlaceholderText('Search categories'), 'cafe');
    await user.click(screen.getByRole('option', { name: /Café/ }));
    expect(screen.getByTestId('value')).toHaveTextContent('hardware,cafe');
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Remove Quincaillerie' }));
    expect(screen.getByTestId('value')).toHaveTextContent('cafe');
  });

  it('never matches ids while searching, and announces chosen options', async () => {
    const user = userEvent.setup();
    render(<Harness initial={['florist']} />);
    await user.click(screen.getByRole('combobox'));
    await user.type(screen.getByPlaceholderText('Search categories'), 'id-');
    expect(screen.getByText('No category')).toBeInTheDocument();
    await user.clear(screen.getByPlaceholderText('Search categories'));
    expect(screen.getByRole('option', { name: /Fleuriste selected/ })).toBeInTheDocument();
    expect(screen.getByRole('listbox')).toHaveAttribute('aria-multiselectable', 'true');
  });

  it('single mode replaces the selection and closes', async () => {
    const user = userEvent.setup();
    render(<Harness multiple={false} initial={['florist']} />);
    expect(screen.getByRole('combobox')).toHaveTextContent('Fleuriste');
    await user.click(screen.getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: /Café/ }));
    expect(screen.getByTestId('value')).toHaveTextContent('cafe');
    expect(screen.queryByPlaceholderText('Search categories')).not.toBeInTheDocument();
  });
});
