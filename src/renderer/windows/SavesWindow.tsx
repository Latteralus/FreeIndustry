import { useState } from 'react';
import type { SessionView } from '../../shared/ipc/contract';
import type { SaveKind, SaveStatus, SaveSummary } from '../../shared/ipc/saves';
import { DataTable, type Column } from '../components/DataTable';
import { Dialog } from '../components/Dialog';
import { Dropdown } from '../components/Dropdown';
import { Inspector } from '../components/Inspector';
import { formatDate, formatTime } from '../app/clock-format';
import {
  filterValue,
  withFilter,
  withSort,
  type WindowViewProps,
} from '../app/desktop/window-catalog';
import type { SavesView } from '../app/useSaves';

/**
 * Saved Games window (File → Saved Games): the save slots the worker lists,
 * with load, overwrite and export, and import. Every action is a request the
 * worker validates; file paths are chosen in native dialogs owned by
 * Electron main and never reach the renderer (ADR-0028).
 */

const KIND_LABEL: Record<SaveKind, string> = {
  manual: 'Save',
  autosave: 'Autosave',
  recovered: 'Recovered',
};

const STATUS_LABEL: Record<SaveStatus, string> = {
  ready: 'OK',
  'needs-upgrade': 'Older format',
  incompatible: 'Incompatible',
  unreadable: 'Unreadable',
};

const KIND_FILTERS = ['all', 'manual', 'autosave', 'recovered'] as const;
type KindFilter = (typeof KIND_FILTERS)[number];

const KIND_FILTER_LABEL: Record<KindFilter, string> = {
  all: 'All saves',
  manual: 'Your saves',
  autosave: 'Autosaves',
  recovered: 'Recovered sessions',
};

export interface SavesWindowProps extends WindowViewProps {
  readonly saves: SavesView;
  readonly session: SessionView | null;
  readonly onSaveAs: () => void;
}

export function SavesWindow({ saves, session, onSaveAs, view, onViewChange }: SavesWindowProps) {
  const kind = filterValue<KindFilter>(view, 'kind', KIND_FILTERS, 'all');
  const rows = (saves.saves ?? []).filter((save) => kind === 'all' || save.kind === kind);

  const columns: readonly Column<SaveSummary>[] = [
    {
      id: 'name',
      header: 'Name',
      sortValue: (row) => row.name ?? row.saveId,
      render: (row) => `${row.name ?? row.saveId}${row.current ? ' (current)' : ''}`,
    },
    {
      id: 'kind',
      header: 'Kind',
      sortValue: (row) => (row.kind ? KIND_LABEL[row.kind] : ''),
      render: (row) => (row.kind ? KIND_LABEL[row.kind] : '—'),
    },
    {
      id: 'simulated',
      header: 'Simulated time',
      sortValue: (row) => BigInt(row.world?.nowMs ?? '0'),
      render: (row) =>
        row.world ? `${formatDate(row.world.calendar)} ${formatTime(row.world.calendar)}` : '—',
    },
    {
      id: 'revision',
      header: 'Rev.',
      numeric: true,
      sortValue: (row) => row.world?.worldRevision ?? -1,
      render: (row) => row.world?.worldRevision ?? '—',
    },
    {
      id: 'saved',
      header: 'Saved',
      sortValue: (row) => row.savedAt ?? '',
      render: (row) => (row.savedAt ? new Date(row.savedAt).toLocaleString() : '—'),
    },
    {
      id: 'status',
      header: 'Status',
      sortValue: (row) => STATUS_LABEL[row.status],
      render: (row) => <span title={row.problem ?? undefined}>{STATUS_LABEL[row.status]}</span>,
    },
    { id: 'actions', header: 'Actions', render: (row) => <SaveActions save={row} saves={saves} /> },
  ];

  return (
    <div className="window-content">
      <Inspector
        label="Current world"
        fields={[
          {
            label: 'Saved as',
            value: session?.savedAs?.name ?? 'Not saved',
            testId: 'session-saved-as',
          },
          {
            label: 'Unsaved changes',
            value: session ? (session.unsavedChanges ? 'Yes' : 'No') : '—',
            testId: 'session-unsaved',
          },
          {
            label: 'Crash recovery',
            value: session ? (session.recoveryLog === 'active' ? 'Active' : 'Unavailable') : '—',
            testId: 'session-recovery',
          },
        ]}
      />
      {session?.notice && (
        <p className="notice notice-info" role="status" data-testid="session-notice">
          {session.notice}
        </p>
      )}
      <div className="filter-row">
        <button type="button" disabled={saves.busy} onClick={onSaveAs}>
          Save As…
        </button>
        <button
          type="button"
          disabled={saves.busy}
          onClick={() => {
            void saves.importSave();
          }}
        >
          Import…
        </button>
        <Dropdown<KindFilter>
          label="Show"
          value={kind}
          options={KIND_FILTERS.map((value) => ({ value, label: KIND_FILTER_LABEL[value] }))}
          onChange={(value) => {
            onViewChange(withFilter(view, 'kind', value));
          }}
        />
      </div>
      <DataTable
        label="Save slots"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.saveId}
        rowTestId={() => 'save-row'}
        rowProps={(row) => ({ 'data-save-id': row.saveId })}
        emptyText={saves.saves === null ? 'Reading saves…' : 'No saves.'}
        sort={view.sort ?? null}
        onSortChange={(sort) => {
          onViewChange(withSort(view, sort));
        }}
      />
      <p className="outcome" data-testid="saves-outcome">
        {saves.outcome ?? '—'}
      </p>
    </div>
  );
}

function SaveActions({ save, saves }: { readonly save: SaveSummary; readonly saves: SavesView }) {
  const loadable = save.status === 'ready' || save.status === 'needs-upgrade';
  const label = save.name ?? save.saveId;
  return (
    <span className="table-actions">
      <button
        type="button"
        aria-label={`Load ${label}`}
        disabled={saves.busy || !loadable}
        onClick={() => {
          void saves.load(save);
        }}
      >
        Load
      </button>
      {save.kind === 'manual' && (
        <button
          type="button"
          aria-label={`Overwrite ${label}`}
          disabled={saves.busy || save.status !== 'ready'}
          onClick={() => {
            void saves.overwrite(save);
          }}
        >
          Overwrite
        </button>
      )}
      <button
        type="button"
        aria-label={`Export ${label}`}
        disabled={saves.busy || save.status === 'unreadable'}
        onClick={() => {
          void saves.exportSave(save);
        }}
      >
        Export…
      </button>
    </span>
  );
}

/** File → Save As: name a new save of the current world. */
export function SaveAsDialog({
  saves,
  initialName,
  onClose,
}: {
  readonly saves: SavesView;
  readonly initialName: string;
  readonly onClose: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();
  return (
    <Dialog title="Save As" onClose={onClose} testId="save-as-dialog">
      <form
        className="form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          void saves.saveNew(trimmed).then((result) => {
            if (result.ok) {
              onClose();
            } else {
              setError(result.message);
            }
          });
        }}
      >
        <label htmlFor="save-name">Save name</label>
        <input
          id="save-name"
          value={name}
          maxLength={60}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
        <span />
        <span className="button-row">
          <button type="submit" disabled={saves.busy || trimmed.length === 0}>
            Save
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </span>
      </form>
      {error && (
        <p className="notice notice-warning" role="alert" data-testid="save-as-error">
          {error}
        </p>
      )}
    </Dialog>
  );
}
