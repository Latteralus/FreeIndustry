import { useEffect, useEffectEvent, useRef } from 'react';

/**
 * A drop-down command menu, as used by the menubar and by each window's
 * system menu. Keyboard: Up/Down/Home/End move, Enter/Space choose, Escape
 * closes, Left/Right move to the neighbouring menubar menu, Tab closes.
 *
 * A command that does not work yet is shown disabled with the reason as its
 * tooltip; it cannot be chosen (no fake functionality, plan Step 06).
 */

export type MenuEntry =
  | {
      readonly kind: 'command';
      readonly id: string;
      readonly label: string;
      readonly shortcut?: string;
      /** Why the command cannot be used now; null or absent when it can. */
      readonly disabledReason?: string | null;
      /** For check and radio items. */
      readonly checked?: boolean;
      readonly role?: 'menuitem' | 'menuitemcheckbox' | 'menuitemradio';
      readonly onSelect: () => void;
    }
  | { readonly kind: 'separator'; readonly id: string };

export type CommandEntry = Extract<MenuEntry, { kind: 'command' }>;

export interface PopupMenuProps {
  readonly entries: readonly MenuEntry[];
  /** Accessible name of the menu (usually the menubar button's ID). */
  readonly labelledBy?: string;
  readonly label?: string;
  readonly className?: string;
  readonly onClose: (reason: 'chosen' | 'escape' | 'tab') => void;
  /** Left/Right arrow: move to the neighbouring menu. */
  readonly onNavigate?: (direction: -1 | 1) => void;
  readonly initialFocus?: 'first' | 'last';
}

const isEnabled = (entry: CommandEntry) =>
  entry.disabledReason === undefined || entry.disabledReason === null;

export function PopupMenu({
  entries,
  labelledBy,
  label,
  className,
  onClose,
  onNavigate,
  initialFocus = 'first',
}: PopupMenuProps) {
  const listRef = useRef<HTMLUListElement>(null);

  const items = () =>
    Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-menu-item]') ?? []);

  useEffect(() => {
    const all = items();
    (initialFocus === 'first' ? all[0] : all[all.length - 1])?.focus();
  }, [initialFocus]);

  /** Choose the command an item element stands for (if it is enabled). */
  const choose = (element: Element | null) => {
    const id = element?.closest<HTMLElement>('[data-menu-item]')?.dataset['menuItem'];
    const entry = entries.find(
      (candidate): candidate is CommandEntry => candidate.kind === 'command' && candidate.id === id,
    );
    if (!entry || !isEnabled(entry)) {
      return;
    }
    onClose('chosen');
    entry.onSelect();
  };

  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    const all = items();
    const index = all.findIndex((item) => item === document.activeElement);
    const focusAt = (next: number) => {
      all[(next + all.length) % all.length]?.focus();
    };
    switch (event.key) {
      case 'Enter':
      case ' ':
        choose(document.activeElement);
        break;
      case 'ArrowDown':
        focusAt(index + 1);
        break;
      case 'ArrowUp':
        focusAt(index - 1);
        break;
      case 'Home':
        focusAt(0);
        break;
      case 'End':
        focusAt(all.length - 1);
        break;
      case 'Escape':
        onClose('escape');
        break;
      case 'Tab':
        onClose('tab');
        return; // let the focus move on
      case 'ArrowLeft':
        onNavigate?.(-1);
        break;
      case 'ArrowRight':
        onNavigate?.(1);
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  });

  const onClick = useEffectEvent((event: MouseEvent) => {
    choose(event.target as Element | null);
  });

  // Keyboard and clicks are handled for the whole menu (event delegation).
  useEffect(() => {
    const list = listRef.current;
    const keyListener = (event: KeyboardEvent) => {
      onKeyDown(event);
    };
    const clickListener = (event: MouseEvent) => {
      onClick(event);
    };
    list?.addEventListener('keydown', keyListener);
    list?.addEventListener('click', clickListener);
    return () => {
      list?.removeEventListener('keydown', keyListener);
      list?.removeEventListener('click', clickListener);
    };
  }, []);

  return (
    <ul
      ref={listRef}
      role="menu"
      aria-labelledby={labelledBy}
      aria-label={label}
      className={`popup-menu ${className ?? ''}`}
    >
      {entries.map((entry) =>
        entry.kind === 'separator' ? (
          <li key={entry.id} role="separator" className="popup-menu-separator" />
        ) : (
          <li
            key={entry.id}
            role={entry.role ?? 'menuitem'}
            data-menu-item={entry.id}
            tabIndex={-1}
            aria-disabled={isEnabled(entry) ? undefined : true}
            aria-checked={
              entry.role && entry.role !== 'menuitem' ? entry.checked === true : undefined
            }
            title={entry.disabledReason ?? undefined}
            className="popup-menu-item"
          >
            <span className="popup-menu-check" aria-hidden="true">
              {entry.checked ? (entry.role === 'menuitemradio' ? '•' : '✓') : ''}
            </span>
            <span className="popup-menu-label">{entry.label}</span>
            <span className="popup-menu-shortcut" aria-hidden="true">
              {entry.shortcut ?? ''}
            </span>
          </li>
        ),
      )}
    </ul>
  );
}
