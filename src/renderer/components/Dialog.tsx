import { useEffect, useEffectEvent, useId, useRef, type ReactNode } from 'react';

/**
 * A modal dialog box (Save As, About, …). It keeps the keyboard inside
 * itself, closes on Escape, starts on its first field and gives the focus
 * back where it was when it closes.
 */

export interface DialogProps {
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly testId?: string;
}

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({ title, onClose, children, testId }: DialogProps) {
  const titleId = useId();
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const body = boxRef.current?.querySelector<HTMLElement>('.dialog-body');
    const first = body?.querySelector<HTMLElement>(FOCUSABLE) ?? boxRef.current;
    first?.focus();
    return () => {
      previous?.focus();
    };
  }, []);

  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') {
      return;
    }
    const focusable = Array.from(boxRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  // Escape and the Tab trap, listened for on the dialog box itself.
  useEffect(() => {
    const box = boxRef.current;
    const listener = (event: KeyboardEvent) => {
      onKeyDown(event);
    };
    box?.addEventListener('keydown', listener);
    return () => {
      box?.removeEventListener('keydown', listener);
    };
  }, []);

  return (
    <div className="modal-overlay">
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="dialog"
        data-testid={testId}
      >
        <div className="window-titlebar window-titlebar-active">
          <span id={titleId} className="window-title">
            {title}
          </span>
          <button
            type="button"
            className="window-control"
            aria-label={`Close ${title}`}
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="dialog-body">{children}</div>
      </div>
    </div>
  );
}
