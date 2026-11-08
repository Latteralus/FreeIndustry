import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { PopupMenu, type MenuEntry } from './PopupMenu';

/**
 * The application menubar (spec §3.2), drawn in the renderer like a classic
 * Windows application's. Keyboard: Alt (pressed and released alone) or F10
 * moves to the menubar; Alt+letter opens the menu with that underlined
 * letter; Left/Right move along the bar; Down, Enter or Space open a menu.
 */

export interface MenuDefinition {
  readonly id: string;
  readonly label: string;
  /** The underlined access letter; must occur in the label. */
  readonly mnemonic: string;
  readonly entries: readonly MenuEntry[];
}

export interface MenuBarProps {
  readonly menus: readonly MenuDefinition[];
  /** Set while a modal dialog is open: the menubar ignores the keyboard. */
  readonly inert?: boolean;
}

function Label({ label, mnemonic }: { label: string; mnemonic: string }) {
  const at = label.toLowerCase().indexOf(mnemonic.toLowerCase());
  if (at < 0) {
    return <>{label}</>;
  }
  return (
    <>
      {label.slice(0, at)}
      <span className="mnemonic">{label.slice(at, at + 1)}</span>
      {label.slice(at + 1)}
    </>
  );
}

export function MenuBar({ menus, inert = false }: MenuBarProps) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [focusFrom, setFocusFrom] = useState<'first' | 'last'>('first');
  const barRef = useRef<HTMLDivElement>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const [rovingIndex, setRovingIndex] = useState(0);

  const focusButton = (index: number) => {
    const count = menus.length;
    const next = (index + count) % count;
    setRovingIndex(next);
    buttons.current[next]?.focus();
  };

  const openMenu = (index: number, from: 'first' | 'last' = 'first') => {
    const count = menus.length;
    const next = (index + count) % count;
    setRovingIndex(next);
    setFocusFrom(from);
    setOpenIndex(next);
  };

  // Alt alone, F10 and Alt+letter, from anywhere in the app.
  useEffect(() => {
    if (inert) {
      return undefined;
    }
    let altAlone = false;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Alt') {
        altAlone = !event.repeat;
        return;
      }
      altAlone = false;
      if (event.key === 'F10' && !event.shiftKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        setOpenIndex(null);
        focusButton(0);
        return;
      }
      if (event.altKey && !event.ctrlKey && event.key.length === 1) {
        const letter = event.key.toLowerCase();
        const index = menus.findIndex((menu) => menu.mnemonic.toLowerCase() === letter);
        if (index >= 0) {
          event.preventDefault();
          openMenu(index);
        }
      }
    };
    const onKeyUp = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Alt' && altAlone) {
        altAlone = false;
        event.preventDefault();
        if (barRef.current?.contains(document.activeElement)) {
          setOpenIndex(null);
          (document.activeElement as HTMLElement | null)?.blur();
        } else {
          focusButton(0);
        }
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!barRef.current?.contains(event.target as Node)) {
        setOpenIndex(null);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keyup', onKeyUp);
      document.removeEventListener('pointerdown', onPointerDown);
    };
    // focusButton and openMenu only read refs and the menu count.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inert, menus]);

  const onBarKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    switch (event.key) {
      case 'ArrowRight':
        focusButton(index + 1);
        break;
      case 'ArrowLeft':
        focusButton(index - 1);
        break;
      case 'Home':
        focusButton(0);
        break;
      case 'End':
        focusButton(menus.length - 1);
        break;
      case 'ArrowDown':
      case 'Enter':
      case ' ':
        openMenu(index, 'first');
        break;
      case 'ArrowUp':
        openMenu(index, 'last');
        break;
      case 'Escape':
        buttons.current[index]?.blur();
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <div ref={barRef} role="menubar" aria-label="Main menu" className="menubar">
      {menus.map((menu, index) => {
        const open = openIndex === index;
        return (
          <div key={menu.id} className="menubar-entry">
            <button
              ref={(element) => {
                buttons.current[index] = element;
              }}
              type="button"
              role="menuitem"
              id={`menu-${menu.id}`}
              aria-label={menu.label}
              aria-haspopup="menu"
              aria-expanded={open}
              tabIndex={index === rovingIndex ? 0 : -1}
              className={`menubar-button${open ? ' menubar-button-open' : ''}`}
              onClick={() => {
                if (open) {
                  setOpenIndex(null);
                } else {
                  openMenu(index);
                }
              }}
              onPointerEnter={() => {
                if (openIndex !== null && !open) {
                  openMenu(index);
                }
              }}
              onKeyDown={(event) => {
                onBarKeyDown(event, index);
              }}
            >
              <Label label={menu.label} mnemonic={menu.mnemonic} />
            </button>
            {open && (
              <PopupMenu
                entries={menu.entries}
                labelledBy={`menu-${menu.id}`}
                className="menubar-popup"
                initialFocus={focusFrom}
                onClose={(reason) => {
                  setOpenIndex(null);
                  if (reason === 'escape') {
                    buttons.current[index]?.focus();
                  }
                }}
                onNavigate={(direction) => {
                  openMenu(index + direction);
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
