import type { ReactNode } from 'react';

/**
 * An error or warning message box shown over the workspace, for conditions
 * the player must see (the worker stopped, the simulation faulted). It is an
 * alert: screen readers announce it when it appears.
 */

export interface MessageBoxProps {
  readonly title: string;
  readonly children: ReactNode;
  readonly actions?: ReactNode;
}

export function MessageBox({ title, children, actions }: MessageBoxProps) {
  return (
    <div role="alert" className="message-box">
      <div className="window-titlebar window-titlebar-alert">
        <span className="window-title">{title}</span>
      </div>
      <div className="message-box-body">
        <h2 className="message-box-heading">{title}</h2>
        {children}
        {actions && <div className="message-box-actions">{actions}</div>}
      </div>
    </div>
  );
}

/** A one-line inline notice inside a window (warning, refusal). */
export function Notice({
  kind,
  children,
  testId,
}: {
  readonly kind: 'warning' | 'info';
  readonly children: ReactNode;
  readonly testId?: string;
}) {
  return (
    <p
      className={`notice notice-${kind}`}
      role={kind === 'warning' ? 'alert' : 'status'}
      data-testid={testId}
    >
      {children}
    </p>
  );
}
