import type { ColumnDef, RowSelectionState, SortingState } from '@tanstack/react-table';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { DataTable } from './data-table.tsx';

interface Business {
  id: string;
  name: string;
  rating: number;
}

const columns: ColumnDef<Business, unknown>[] = [
  { accessorKey: 'name', header: 'Name' },
  { accessorKey: 'rating', header: 'Rating' },
];
const rows: Business[] = [
  { id: 'b', name: 'Le Tamarin', rating: 4.4 },
  { id: 'a', name: 'Bonito', rating: 4.7 },
  { id: 'c', name: 'Eddy’s', rating: 4.1 },
];
const names = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((r) => within(r).getAllByRole('cell')[0]?.textContent);

function Harness({ data = rows }: { data?: Business[] }) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [selection, setSelection] = useState<RowSelectionState>({ a: true });
  return (
    <DataTable
      columns={columns}
      data={data}
      getRowId={(r) => r.id}
      empty={<p>Nothing here</p>}
      sorting={sorting}
      onSortingChange={setSorting}
      rowSelection={selection}
      onRowSelectionChange={setSelection}
      caption="Businesses"
    />
  );
}

describe('DataTable', () => {
  it('renders rows and sorts by clicking headers, announcing the order', async () => {
    render(<Harness />);
    expect(names()).toEqual(['Le Tamarin', 'Bonito', 'Eddy’s']);
    // Numbers sort highest first on the first click (TanStack default), text A→Z.
    await userEvent.click(screen.getByRole('button', { name: 'Rating' }));
    expect(names()).toEqual(['Bonito', 'Le Tamarin', 'Eddy’s']);
    expect(screen.getByRole('columnheader', { name: 'Rating' })).toHaveAttribute('aria-sort', 'descending');
    await userEvent.click(screen.getByRole('button', { name: 'Rating' }));
    expect(names()).toEqual(['Eddy’s', 'Le Tamarin', 'Bonito']);
    expect(screen.getByRole('columnheader', { name: 'Rating' })).toHaveAttribute('aria-sort', 'ascending');
    await userEvent.click(screen.getByRole('button', { name: 'Name' }));
    expect(names()).toEqual(['Bonito', 'Eddy’s', 'Le Tamarin']);
  });

  it('marks selected rows', () => {
    render(<Harness />);
    const selected = screen.getAllByRole('row').filter((r) => r.getAttribute('data-state') === 'selected');
    expect(selected.map((r) => within(r).getAllByRole('cell')[0]?.textContent)).toEqual(['Bonito']);
  });

  it('shows the empty state when there are no rows', () => {
    render(<Harness data={[]} />);
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('renders a window of rows for long lists', () => {
    const many = Array.from({ length: 1_000 }, (_, i) => ({
      id: String(i),
      name: `Business ${i}`,
      rating: 4,
    }));
    render(<Harness data={many} />);
    expect(screen.getAllByRole('row').length).toBeLessThan(100);
  });
});
