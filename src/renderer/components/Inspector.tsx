import type { ReactNode } from 'react';

/**
 * A property inspector: label/value pairs for one object (spec §3.4, every
 * major object has an inspectable record). Values are formatted by the
 * caller from the worker's read model.
 */

export interface InspectorField {
  readonly label: string;
  readonly value: ReactNode;
  readonly testId?: string;
  /** Monospaced (hashes, identifiers). */
  readonly code?: boolean;
}

export function Inspector({
  fields,
  label,
}: {
  readonly fields: readonly InspectorField[];
  readonly label?: string;
}) {
  return (
    <dl className="inspector" aria-label={label}>
      {fields.map((field) => (
        <div key={field.label} className="inspector-row">
          <dt>{field.label}</dt>
          <dd data-testid={field.testId} className={field.code ? 'inspector-code' : undefined}>
            {field.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
