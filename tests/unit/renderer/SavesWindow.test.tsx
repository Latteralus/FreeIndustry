import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import type { WindowView } from '../../../src/renderer/app/desktop/window-model';
import { useSaves } from '../../../src/renderer/app/useSaves';
import { SaveAsDialog, SavesWindow } from '../../../src/renderer/windows/SavesWindow';
import type { SimulationBridge } from '../../../src/shared/bridge';
import type { HostEvent, SessionView } from '../../../src/shared/ipc/contract';
import { FakeSaves, saveSummary as summary, WORLD } from '../../support/renderer-fakes';

class FakeEvents implements Pick<SimulationBridge, 'subscribe'> {
  readonly listeners = new Set<(event: HostEvent) => void>();
  subscribe(listener: (event: HostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: HostEvent) {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

const SESSION: SessionView = {
  worldId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
  savedAs: null,
  unsavedChanges: true,
  recoveryLog: 'active',
  notice: null,
};

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function Harness({
  saves,
  events,
  session,
  beforeWorldChange,
}: {
  saves: FakeSaves;
  events: FakeEvents;
  session: SessionView | null;
  beforeWorldChange?: () => Promise<void>;
}) {
  const view = useSaves(saves, events as unknown as SimulationBridge, {
    ...(beforeWorldChange ? { beforeWorldChange } : {}),
  });
  const [windowView, setWindowView] = useState<WindowView>({});
  const [dialog, setDialog] = useState(false);
  return (
    <>
      <SavesWindow
        saves={view}
        session={session}
        onSaveAs={() => {
          setDialog(true);
        }}
        view={windowView}
        onViewChange={setWindowView}
      />
      {dialog && (
        <SaveAsDialog
          saves={view}
          initialName=""
          onClose={() => {
            setDialog(false);
          }}
        />
      )}
    </>
  );
}

async function renderWindow(
  saves: FakeSaves,
  session: SessionView | null = SESSION,
  beforeWorldChange?: () => Promise<void>,
) {
  const events = new FakeEvents();
  const view = render(
    <Harness
      saves={saves}
      events={events}
      session={session}
      {...(beforeWorldChange ? { beforeWorldChange } : {})}
    />,
  );
  await settle();
  return { ...view, events };
}

describe('Saved Games window', () => {
  it('shows the session state and an empty list', async () => {
    await renderWindow(new FakeSaves());
    expect(screen.getByTestId('session-saved-as')).toHaveTextContent('Not saved');
    expect(screen.getByTestId('session-unsaved')).toHaveTextContent('Yes');
    expect(screen.getByTestId('session-recovery')).toHaveTextContent('Active');
    expect(screen.getByText('No saves.')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('lists saves with their simulated time, revision, kind and status', async () => {
    const saves = new FakeSaves();
    saves.saves = [
      summary({ current: true }),
      summary({ saveId: 'autosave-1', name: 'Autosave', kind: 'autosave' }),
      summary({
        saveId: 'save-9',
        name: null,
        kind: null,
        savedAt: null,
        world: null,
        status: 'unreadable',
        problem: 'This file is not a FreeIndustry save.',
      }),
    ];
    await renderWindow(saves);
    const rows = screen.getAllByTestId('save-row');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Shop (current)Save') as unknown,
      expect.stringContaining('AutosaveAutosave') as unknown,
      expect.stringContaining('save-9—') as unknown,
    ]);
    expect(rows[0]).toHaveTextContent('Mon 1 Jan 1996 00:10:00');
    expect(screen.getByTitle('This file is not a FreeIndustry save.')).toHaveTextContent(
      'Unreadable',
    );
    // Only the player's own saves can be overwritten; unreadable ones cannot be loaded.
    expect(screen.getByRole('button', { name: 'Overwrite Shop' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Overwrite Autosave' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load save-9' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Export save-9' })).toBeDisabled();
    // The kind filter narrows the list.
    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'autosave' } });
    expect(screen.getAllByTestId('save-row')).toHaveLength(1);
  });

  it('Save As names a new save, trimmed, closes on success and refreshes the list', async () => {
    const saves = new FakeSaves();
    await renderWindow(saves);
    fireEvent.click(screen.getByRole('button', { name: 'Save As…' }));
    const dialog = screen.getByRole('dialog', { name: 'Save As' });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Save name'), { target: { value: '  Before lunch ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await settle();
    expect(saves.requests).toEqual([{ name: 'Before lunch', saveId: null }]);
    expect(dialog).not.toBeInTheDocument();
    expect(screen.getByTestId('saves-outcome')).toHaveTextContent('Saved "Before lunch".');
    expect(screen.getAllByTestId('save-row')).toHaveLength(1);
  });

  it('a failed Save As keeps the dialog open with the reason', async () => {
    const saves = new FakeSaves();
    saves.nextSave = {
      ok: false,
      error: { code: 'SAVE_FAILED', message: 'The disk is full; nothing was saved.' },
    } as never;
    await renderWindow(saves);
    fireEvent.click(screen.getByRole('button', { name: 'Save As…' }));
    fireEvent.change(screen.getByLabelText('Save name'), { target: { value: 'Big' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await settle();
    expect(screen.getByRole('dialog', { name: 'Save As' })).toBeInTheDocument();
    expect(screen.getByTestId('save-as-error')).toHaveTextContent(
      'Save failed (SAVE_FAILED): The disk is full; nothing was saved.',
    );
  });

  it('overwrites, loads and exports by ID; saving and loading first store presentation settings', async () => {
    const log: string[] = [];
    const saves = new FakeSaves(log);
    saves.saves = [summary()];
    await renderWindow(saves, SESSION, () => {
      log.push('flush');
      return Promise.resolve();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Overwrite Shop' }));
    await settle();
    expect(screen.getByTestId('saves-outcome')).toHaveTextContent('Saved over "Shop".');
    fireEvent.click(screen.getByRole('button', { name: 'Load Shop' }));
    await settle();
    expect(screen.getByTestId('saves-outcome')).toHaveTextContent('Loaded "Shop".');
    fireEvent.click(screen.getByRole('button', { name: 'Export Shop' }));
    await settle();
    expect(screen.getByTestId('saves-outcome')).toHaveTextContent('Exported "Shop".');
    expect(saves.requests).toEqual([
      { name: 'Shop', saveId: 'save-1' },
      'load save-1',
      'export save-1',
    ]);
    // The layout is flushed before the world is written or replaced, never after.
    expect(log).toEqual(['flush', 'save Shop', 'flush', 'load save-1']);
  });

  it('reports failures and cancellations in words', async () => {
    const saves = new FakeSaves();
    saves.saves = [summary()];
    saves.nextLoad = {
      ok: false,
      error: {
        code: 'SAVE_CORRUPT',
        message: 'This save is damaged: journal sequence numbers are not contiguous from 1',
      },
    } as never;
    saves.nextExport = { ok: true, value: { status: 'cancelled' } };
    await renderWindow(saves);
    fireEvent.click(screen.getByRole('button', { name: 'Load Shop' }));
    await settle();
    expect(screen.getByTestId('saves-outcome')).toHaveTextContent(
      'Load failed (SAVE_CORRUPT): This save is damaged: journal sequence numbers are not contiguous from 1',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Export Shop' }));
    await settle();
    expect(screen.getByTestId('saves-outcome')).toHaveTextContent('Export cancelled.');
    fireEvent.click(screen.getByRole('button', { name: 'Import…' }));
    await settle();
    expect(screen.getByTestId('saves-outcome')).toHaveTextContent('Import cancelled.');
  });

  it('refreshes when the worker reports that saves changed (autosave, recovery)', async () => {
    const saves = new FakeSaves();
    const { events } = await renderWindow(saves);
    expect(saves.lists).toBe(1);
    saves.saves = [summary({ saveId: 'autosave-1', name: 'Autosave', kind: 'autosave' })];
    events.emit({ type: 'saves.changed' });
    await settle();
    expect(saves.lists).toBe(2);
    expect(screen.getAllByTestId('save-row')).toHaveLength(1);
    // Clock events do not refetch the list.
    events.emit({ type: 'world.clock', worldInstanceId: WORLD, nowMs: '1' });
    await settle();
    expect(saves.lists).toBe(2);
  });

  it('shows the recovery notice and the saved-as name', async () => {
    await renderWindow(new FakeSaves(), {
      ...SESSION,
      savedAs: { saveId: 'save-1', name: 'Shop' },
      unsavedChanges: false,
      recoveryLog: 'unavailable',
      notice: 'The previous session ended unexpectedly. It was rebuilt…',
    });
    expect(screen.getByTestId('session-saved-as')).toHaveTextContent('Shop');
    expect(screen.getByTestId('session-unsaved')).toHaveTextContent('No');
    expect(screen.getByTestId('session-recovery')).toHaveTextContent('Unavailable');
    expect(screen.getByRole('status')).toHaveTextContent(
      'The previous session ended unexpectedly.',
    );
  });
});
