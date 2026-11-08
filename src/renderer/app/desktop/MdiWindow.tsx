import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { PopupMenu, type MenuEntry } from '../../components/PopupMenu';
import {
  placeInWorkspace,
  resizeFromEdge,
  type Bounds,
  type Size,
  type ResizeEdge,
  type WindowAction,
  type WindowDefinition,
  type WindowRecord,
} from './window-model';

/**
 * One management window inside the workspace (spec §3.2): a title bar to
 * drag, edges and corners to resize, minimize / maximize / close buttons,
 * and a system menu (the box at the left of the title bar, or Alt+Minus)
 * whose Move and Size commands let the keyboard do what the mouse does:
 * arrows move or size by 8 pixels (Ctrl: 1 pixel), Enter keeps, Escape
 * cancels.
 *
 * While dragging, the window follows the pointer locally; the layout is
 * changed once, when the drag ends.
 */

export interface MdiWindowProps {
  readonly definition: WindowDefinition;
  readonly record: WindowRecord;
  /** Where the window is drawn (maximized fills the workspace). */
  readonly bounds: Bounds;
  readonly zIndex: number;
  readonly active: boolean;
  /** UI scale as a factor (1.25 = 125%): pointer movement is divided by it. */
  readonly scale: number;
  /** Workspace size: a dragged window keeps its title bar reachable. */
  readonly workspace: Size | null;
  readonly onAction: (action: WindowAction) => void;
  readonly systemMenuOpen: boolean;
  readonly onSystemMenu: (open: boolean) => void;
  readonly children: ReactNode;
}

type Gesture =
  | { readonly kind: 'move'; readonly pointerX: number; readonly pointerY: number }
  | {
      readonly kind: 'resize';
      readonly edge: ResizeEdge;
      readonly pointerX: number;
      readonly pointerY: number;
    };

const EDGES: readonly ResizeEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

export function MdiWindow({
  definition,
  record,
  bounds,
  zIndex,
  active,
  scale,
  workspace,
  onAction,
  systemMenuOpen,
  onSystemMenu,
  children,
}: MdiWindowProps) {
  const { id, title, minSize } = definition;
  const [preview, setPreview] = useState<Bounds | null>(null);
  const [keyboardMode, setKeyboardMode] = useState<'move' | 'size' | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const start = useRef<Bounds>(bounds);
  const frameRef = useRef<HTMLDivElement>(null);
  const maximized = record.mode === 'maximized';
  const shown = preview ?? bounds;

  const commit = (next: Bounds | null) => {
    if (next) {
      onAction({ type: 'setBounds', id, bounds: next });
    }
    setPreview(null);
  };

  const beginGesture = (event: PointerEvent<HTMLElement>, next: Gesture) => {
    if (event.button !== 0 || maximized) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = next;
    start.current = bounds;
    setPreview(bounds);
  };

  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const current = gesture.current;
    if (!current) {
      return;
    }
    const dx = Math.round((event.clientX - current.pointerX) / scale);
    const dy = Math.round((event.clientY - current.pointerY) / scale);
    const from = start.current;
    setPreview(
      placeInWorkspace(
        current.kind === 'move'
          ? { ...from, x: from.x + dx, y: from.y + dy }
          : resizeFromEdge(from, current.edge, dx, dy, minSize),
        workspace,
      ),
    );
  };

  const endGesture = (event: PointerEvent<HTMLElement>, keep: boolean) => {
    if (!gesture.current) {
      return;
    }
    gesture.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    commit(keep ? preview : null);
  };

  // The system menu closes when the pointer goes down anywhere else.
  const systemRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!systemMenuOpen) {
      return undefined;
    }
    const onPointerDown = (event: globalThis.PointerEvent) => {
      if (!systemRef.current?.contains(event.target as Node)) {
        onSystemMenu(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [systemMenuOpen, onSystemMenu]);

  // Keyboard Move / Size, entered from the system menu.
  useEffect(() => {
    if (keyboardMode === null) {
      return undefined;
    }
    frameRef.current?.focus();
    const origin = bounds;
    let current = bounds;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const step = event.ctrlKey ? 1 : 8;
      const delta: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      const move = delta[event.key];
      if (move) {
        const [dx, dy] = move;
        current = placeInWorkspace(
          keyboardMode === 'move'
            ? { ...current, x: current.x + dx, y: current.y + dy }
            : resizeFromEdge(current, 'se', dx, dy, minSize),
          workspace,
        );
        setPreview(current);
      } else if (event.key === 'Enter') {
        setKeyboardMode(null);
        commit(current === origin ? null : current);
      } else if (event.key === 'Escape') {
        setKeyboardMode(null);
        setPreview(null);
      } else {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
    };
    // Bounds are captured when the mode starts; commit only dispatches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyboardMode]);

  const systemEntries: MenuEntry[] = [
    {
      kind: 'command',
      id: 'restore',
      label: 'Restore',
      disabledReason: record.mode === 'normal' ? 'The window is already restored.' : null,
      onSelect: () => {
        onAction({ type: 'restore', id });
      },
    },
    {
      kind: 'command',
      id: 'move',
      label: 'Move',
      disabledReason: maximized ? 'A maximized window cannot be moved.' : null,
      onSelect: () => {
        setKeyboardMode('move');
      },
    },
    {
      kind: 'command',
      id: 'size',
      label: 'Size',
      disabledReason: maximized ? 'A maximized window cannot be sized.' : null,
      onSelect: () => {
        setKeyboardMode('size');
      },
    },
    {
      kind: 'command',
      id: 'minimize',
      label: 'Minimize',
      onSelect: () => {
        onAction({ type: 'minimize', id });
      },
    },
    {
      kind: 'command',
      id: 'maximize',
      label: 'Maximize',
      disabledReason: maximized ? 'The window is already maximized.' : null,
      onSelect: () => {
        onAction({ type: 'maximize', id });
      },
    },
    { kind: 'separator', id: 'separator-1' },
    {
      kind: 'command',
      id: 'close',
      label: 'Close',
      shortcut: 'Ctrl+F4',
      onSelect: () => {
        onAction({ type: 'close', id });
      },
    },
    { kind: 'separator', id: 'separator-2' },
    {
      kind: 'command',
      id: 'next',
      label: 'Next Window',
      shortcut: 'Ctrl+F6',
      onSelect: () => {
        onAction({ type: 'cycle', delta: 1 });
      },
    },
  ];

  const titleId = `window-${id}-title`;
  return (
    <div
      ref={frameRef}
      role="dialog"
      aria-labelledby={titleId}
      aria-modal="false"
      tabIndex={-1}
      data-window-id={id}
      data-active={active ? 'true' : 'false'}
      data-mode={record.mode}
      hidden={record.mode === 'minimized'}
      className={`window${active ? ' window-active' : ''}${maximized ? ' window-maximized' : ''}${keyboardMode ? ' window-keyboard-mode' : ''}`}
      style={{
        left: shown.x,
        top: shown.y,
        width: shown.width,
        height: shown.height,
        zIndex,
      }}
      onPointerDownCapture={() => {
        if (!active) {
          onAction({ type: 'focus', id });
        }
      }}
    >
      <div
        className={`window-titlebar${active ? ' window-titlebar-active' : ''}`}
        onPointerDown={(event) => {
          if ((event.target as HTMLElement).closest('button')) {
            return;
          }
          beginGesture(event, { kind: 'move', pointerX: event.clientX, pointerY: event.clientY });
        }}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => {
          endGesture(event, true);
        }}
        onPointerCancel={(event) => {
          endGesture(event, false);
        }}
        onDoubleClick={(event) => {
          if (!(event.target as HTMLElement).closest('button')) {
            onAction(maximized ? { type: 'restore', id } : { type: 'maximize', id });
          }
        }}
      >
        <span ref={systemRef} className="window-system">
          <button
            type="button"
            className="window-control window-system-button"
            aria-label={`Window menu: ${title}`}
            aria-haspopup="menu"
            aria-expanded={systemMenuOpen}
            onClick={() => {
              onSystemMenu(!systemMenuOpen);
            }}
          >
            ─
          </button>
          {systemMenuOpen && (
            <PopupMenu
              entries={systemEntries}
              label={`Window menu: ${title}`}
              className="window-system-menu"
              onClose={() => {
                onSystemMenu(false);
              }}
            />
          )}
        </span>
        <span id={titleId} className="window-title">
          {title}
        </span>
        {keyboardMode && (
          <span className="window-mode-hint" role="status">
            {keyboardMode === 'move' ? 'Move' : 'Size'}: arrow keys, Enter to keep, Esc to cancel
          </span>
        )}
        <button
          type="button"
          className="window-control"
          aria-label={`Minimize ${title}`}
          title="Minimize"
          onClick={() => {
            onAction({ type: 'minimize', id });
          }}
        >
          _
        </button>
        <button
          type="button"
          className="window-control"
          aria-label={maximized ? `Restore ${title}` : `Maximize ${title}`}
          title={maximized ? 'Restore' : 'Maximize'}
          onClick={() => {
            onAction(maximized ? { type: 'restore', id } : { type: 'maximize', id });
          }}
        >
          {maximized ? '❐' : '□'}
        </button>
        <button
          type="button"
          className="window-control"
          aria-label={`Close ${title}`}
          title="Close (Ctrl+F4)"
          onClick={() => {
            onAction({ type: 'close', id });
          }}
        >
          ×
        </button>
      </div>
      <div className="window-body">{children}</div>
      {!maximized &&
        EDGES.map((edge) => (
          <div
            key={edge}
            aria-hidden="true"
            data-resize={edge}
            className={`window-resize window-resize-${edge}`}
            onPointerDown={(event) => {
              beginGesture(event, {
                kind: 'resize',
                edge,
                pointerX: event.clientX,
                pointerY: event.clientY,
              });
            }}
            onPointerMove={onPointerMove}
            onPointerUp={(event) => {
              endGesture(event, true);
            }}
            onPointerCancel={(event) => {
              endGesture(event, false);
            }}
          />
        ))}
    </div>
  );
}
