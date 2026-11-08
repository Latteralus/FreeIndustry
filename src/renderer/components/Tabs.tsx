import { useRef, type KeyboardEvent, type ReactNode } from 'react';

/**
 * Compact property-sheet tabs. Only the selected tab's panel is rendered.
 * Keyboard: Left/Right/Home/End move between tabs (automatic activation).
 */

export interface TabDefinition {
  readonly id: string;
  readonly label: string;
}

export interface TabsProps {
  /** Unique prefix for element IDs. */
  readonly idPrefix: string;
  readonly label: string;
  readonly tabs: readonly TabDefinition[];
  readonly selected: string;
  readonly onSelect: (id: string) => void;
  readonly children: ReactNode;
}

/** The selected tab, or the first when the remembered one no longer exists. */
export function selectedTab(tabs: readonly TabDefinition[], remembered: string | undefined) {
  return tabs.find((tab) => tab.id === remembered)?.id ?? tabs[0]?.id ?? '';
}

export function Tabs({ idPrefix, label, tabs, selected, onSelect, children }: TabsProps) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const current = selectedTab(tabs, selected);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number;
    switch (event.key) {
      case 'ArrowRight':
        next = (index + 1) % tabs.length;
        break;
      case 'ArrowLeft':
        next = (index - 1 + tabs.length) % tabs.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = tabs.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const tab = tabs[next];
    if (tab) {
      onSelect(tab.id);
      refs.current[next]?.focus();
    }
  };

  return (
    <div className="tabs">
      <div role="tablist" aria-label={label} className="tabs-list">
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            ref={(element) => {
              refs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${tab.id}`}
            aria-selected={tab.id === current}
            aria-controls={`${idPrefix}-panel`}
            tabIndex={tab.id === current ? 0 : -1}
            className="tabs-tab"
            onClick={() => {
              onSelect(tab.id);
            }}
            onKeyDown={(event) => {
              onKeyDown(event, index);
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${idPrefix}-panel`}
        aria-labelledby={`${idPrefix}-tab-${current}`}
        className="tabs-panel"
      >
        {children}
      </div>
    </div>
  );
}
