import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import {
  DataTable,
  sortRows,
  type Column,
  type SortState,
} from '../../../src/renderer/components/DataTable';
import { Dialog } from '../../../src/renderer/components/Dialog';
import { MenuBar, type MenuDefinition } from '../../../src/renderer/components/MenuBar';
import { Tabs } from '../../../src/renderer/components/Tabs';

/** The element with the keyboard focus (the body when nothing has it). */
const focused = (): Element => document.activeElement ?? document.body;

function menus(chosen: string[]): MenuDefinition[] {
  const command = (id: string, label: string, disabledReason: string | null = null) => ({
    kind: 'command' as const,
    id,
    label,
    disabledReason,
    onSelect: () => {
      chosen.push(id);
    },
  });
  return [
    {
      id: 'file',
      label: 'File',
      mnemonic: 'F',
      entries: [command('open', 'Open…'), { kind: 'separator', id: 's' }, command('exit', 'Exit')],
    },
    {
      id: 'city',
      label: 'City',
      mnemonic: 'Y',
      entries: [command('city-view', 'City View', 'Not built yet: the cityscape.')],
    },
    { id: 'help', label: 'Help', mnemonic: 'H', entries: [command('about', 'About…')] },
  ];
}

describe('menubar', () => {
  it('opens menus with the mouse and chooses commands', () => {
    const chosen: string[] = [];
    render(<MenuBar menus={menus(chosen)} />);
    expect(screen.getByRole('menubar', { name: 'Main menu' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'File' }));
    expect(screen.getByRole('menuitem', { name: 'File' })).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Exit' }));
    expect(chosen).toEqual(['exit']);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('a disabled command shows why and cannot be chosen, by mouse or keyboard', () => {
    const chosen: string[] = [];
    render(<MenuBar menus={menus(chosen)} />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'City' }));
    const item = screen.getByRole('menuitem', { name: 'City View' });
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveAttribute('title', 'Not built yet: the cityscape.');
    fireEvent.click(item);
    fireEvent.keyDown(item, { key: 'Enter' });
    expect(chosen).toEqual([]);
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('Alt+letter opens a menu; arrows move; Enter chooses; Escape returns to the bar', () => {
    const chosen: string[] = [];
    render(<MenuBar menus={menus(chosen)} />);
    fireEvent.keyDown(document, { key: 'f', altKey: true });
    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Open…' })).toHaveFocus();
    fireEvent.keyDown(focused(), { key: 'ArrowDown' });
    expect(within(menu).getByRole('menuitem', { name: 'Exit' })).toHaveFocus();
    fireEvent.keyDown(focused(), { key: 'ArrowDown' });
    expect(within(menu).getByRole('menuitem', { name: 'Open…' })).toHaveFocus();
    fireEvent.keyDown(focused(), { key: 'ArrowRight' });
    expect(screen.getByRole('menuitem', { name: 'City' })).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(focused(), { key: 'ArrowRight' });
    fireEvent.keyDown(focused(), { key: 'Enter' });
    expect(chosen).toEqual(['about']);
    fireEvent.keyDown(document, { key: 'h', altKey: true });
    fireEvent.keyDown(focused(), { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Help' })).toHaveFocus();
  });

  it('Alt alone and F10 move to the menubar; arrows move along it; Down opens', () => {
    render(<MenuBar menus={menus([])} />);
    fireEvent.keyDown(document, { key: 'Alt' });
    fireEvent.keyUp(document, { key: 'Alt' });
    expect(screen.getByRole('menuitem', { name: 'File' })).toHaveFocus();
    fireEvent.keyDown(focused(), { key: 'ArrowLeft' });
    expect(screen.getByRole('menuitem', { name: 'Help' })).toHaveFocus();
    fireEvent.keyDown(focused(), { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'About…' })).toHaveFocus();
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document, { key: 'F10' });
    expect(screen.getByRole('menuitem', { name: 'File' })).toHaveFocus();
  });

  it('ignores the keyboard while a modal dialog is open, and closes on an outside click', () => {
    const { rerender } = render(<MenuBar menus={menus([])} inert />);
    fireEvent.keyDown(document, { key: 'f', altKey: true });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    rerender(<MenuBar menus={menus([])} />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'File' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});

describe('tabs', () => {
  function Harness({ onSelect }: { onSelect: (id: string) => void }) {
    const [tab, setTab] = useState('b');
    return (
      <Tabs
        idPrefix="t"
        label="Sheets"
        tabs={[
          { id: 'a', label: 'Alpha' },
          { id: 'b', label: 'Beta' },
          { id: 'c', label: 'Gamma' },
        ]}
        selected={tab}
        onSelect={(id) => {
          onSelect(id);
          setTab(id);
        }}
      >
        Panel {tab}
      </Tabs>
    );
  }

  it('shows the selected panel and moves with the keyboard', () => {
    const selected: string[] = [];
    render(<Harness onSelect={(id) => selected.push(id)} />);
    expect(screen.getByRole('tab', { name: 'Beta' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Panel b');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Beta' }), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Gamma' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Gamma' }), { key: 'ArrowRight' });
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Alpha' }), { key: 'End' });
    fireEvent.click(screen.getByRole('tab', { name: 'Alpha' }));
    expect(selected).toEqual(['c', 'a', 'c', 'a']);
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Panel a');
  });

  it('falls back to the first tab when the remembered one no longer exists', () => {
    render(
      <Tabs
        idPrefix="x"
        label="X"
        tabs={[{ id: 'one', label: 'One' }]}
        selected="gone"
        onSelect={() => undefined}
      >
        content
      </Tabs>,
    );
    expect(screen.getByRole('tab', { name: 'One' })).toHaveAttribute('aria-selected', 'true');
  });
});

interface Row {
  readonly name: string;
  readonly cents: bigint;
}

const columns: readonly Column<Row>[] = [
  { id: 'name', header: 'Name', sortValue: (row) => row.name, render: (row) => row.name },
  {
    id: 'amount',
    header: 'Amount',
    numeric: true,
    sortValue: (row) => row.cents,
    render: (row) => row.cents.toString(),
  },
  { id: 'note', header: 'Note', render: () => '' },
];

describe('data table', () => {
  const rows: Row[] = [
    { name: 'invoice 10', cents: 5n },
    { name: 'invoice 9', cents: 50n },
    { name: 'Invoice 2', cents: 5n },
  ];

  it('sorts naturally and by integer amounts, keeping ties in their original order', () => {
    expect(
      sortRows(rows, columns, { column: 'name', direction: 'asc' }).map((row) => row.name),
    ).toEqual(['Invoice 2', 'invoice 9', 'invoice 10']);
    expect(
      sortRows(rows, columns, { column: 'amount', direction: 'desc' }).map((row) => row.name),
    ).toEqual(['invoice 9', 'invoice 10', 'Invoice 2']);
    expect(sortRows(rows, columns, null)).toBe(rows);
  });

  it('sorts from the column headings and reports the order to assistive technology', () => {
    function Harness() {
      const [sort, setSort] = useState<SortState | null>(null);
      return (
        <DataTable
          label="Things"
          columns={columns}
          rows={rows}
          rowKey={(row) => row.name}
          sort={sort}
          onSortChange={setSort}
        />
      );
    }
    render(<Harness />);
    const table = screen.getByRole('table', { name: 'Things' });
    expect(within(table).queryByRole('button', { name: 'Note' })).not.toBeInTheDocument();
    fireEvent.click(within(table).getByRole('button', { name: 'Amount' }));
    expect(within(table).getByRole('columnheader', { name: /Amount/ })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );
    fireEvent.click(within(table).getByRole('button', { name: /Amount/ }));
    expect(within(table).getByRole('columnheader', { name: /Amount/ })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
    const names = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((row) => row.firstChild?.textContent);
    expect(names).toEqual(['invoice 9', 'invoice 10', 'Invoice 2']);
  });

  it('says when there is nothing to show', () => {
    render(
      <DataTable
        label="Empty"
        columns={columns}
        rows={[]}
        rowKey={(row) => row.name}
        emptyText="No bills."
      />,
    );
    expect(screen.getByText('No bills.')).toBeInTheDocument();
  });
});

describe('dialog', () => {
  it('is modal: starts on its first field, traps Tab, closes on Escape and restores focus', () => {
    const closed: string[] = [];
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setOpen(true);
            }}
          >
            Open
          </button>
          {open && (
            <Dialog
              title="Save As"
              onClose={() => {
                closed.push('closed');
                setOpen(false);
              }}
            >
              <input aria-label="Name" />
              <button type="button">OK</button>
            </Dialog>
          )}
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Save As' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByLabelText('Name')).toHaveFocus();
    // Tab from the last control wraps to the first (the title bar's close button).
    screen.getByRole('button', { name: 'OK' }).focus();
    fireEvent.keyDown(screen.getByRole('button', { name: 'OK' }), { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'Close Save As' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close Save As' }), {
      key: 'Tab',
      shiftKey: true,
    });
    expect(screen.getByRole('button', { name: 'OK' })).toHaveFocus();
    act(() => {
      fireEvent.keyDown(screen.getByRole('button', { name: 'OK' }), { key: 'Escape' });
    });
    expect(closed).toEqual(['closed']);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
});
