import { Tabs, selectedTab } from '../components/Tabs';
import { withTab, type WindowViewProps } from '../app/desktop/window-catalog';

/**
 * Help (Main Menu, Help → Help Topics; plan Step 07): short, factual notes on
 * what this build does and how to do it. Written for FreeIndustry; no text is
 * taken from the original game. Searchable documentation and context help
 * are Step 31.
 */

const TOPICS = [
  {
    id: 'start',
    label: 'Getting started',
    body: [
      'Choose New Company from the Main Menu or the File menu, pick a scenario, then pick a city in the City Selection window.',
      'In the City View, select a building on the site plan or in the listings. Vacant property can be leased; the Lease dialog founds your company in the same step if you have not founded one yet.',
      'Quick Start founds a ready-made company that leases a small workshop. Either way the premises are empty: no machines, staff or stock come with them.',
    ],
  },
  {
    id: 'property',
    label: 'Cities and property',
    body: [
      'Each city has industrial districts drawn to scale. Every building is drawn from its real floor outline, so a garage is small beside a factory.',
      'A property record gives its floor area (worked out from its outline), dimensions, clear height, floor loading, power and services, doors, permitted uses, rent, deposit and lease terms.',
      'Grey buildings are occupied by businesses already established in the city; they cannot be leased. City averages and rents per square foot are computed from the listings themselves.',
    ],
  },
  {
    id: 'lease',
    label: 'Leases and rent',
    body: [
      'Signing a lease pays the security deposit and the first month’s rent at once. If the funds do not cover both, the landlord refuses.',
      'After that, rent is billed on the same day each month. With a standing order the bank pays it on its due date if the money is there; otherwise the bill becomes overdue and the status bar says so.',
      'At the end of the term the company moves out and the landlord refunds the deposit. Renewals, early termination and buying property arrive with banking and real estate (Step 25). One facility at a time until multi-site operations (Step 26).',
    ],
  },
  {
    id: 'desktop',
    label: 'The desktop',
    body: [
      'Windows open over the factory floor and can be moved, resized, minimized, maximized, tiled and cascaded (Window menu). Alt or F10 opens the menubar; Ctrl+F6 moves between windows.',
      'Units (feet or metres) and the UI scale are in Options. Window layouts are kept with each saved game.',
    ],
  },
  {
    id: 'time',
    label: 'Time and saves',
    body: [
      'The world starts paused. Run, the speeds and the advance buttons are on the toolbar and in the Operations menu; Pause stops time completely.',
      'File → Save and Save As keep the whole world; Saved Games loads, exports and imports them. A changed world is autosaved before a new world or a load replaces it.',
    ],
  },
  {
    id: 'unbuilt',
    label: 'Not built yet',
    body: [
      'Commands for systems that do not exist yet are shown disabled with the reason: equipment and factory layout (Step 08), staff (Step 11), purchasing, sales and the marketplace (Steps 14–21), banking (Step 25) and more.',
    ],
  },
];

export function HelpWindow({ view, onViewChange }: WindowViewProps) {
  const tab = selectedTab(TOPICS, view.tab);
  const topic = TOPICS.find((item) => item.id === tab) ?? TOPICS[0];
  return (
    <div className="window-content help-window">
      <Tabs
        idPrefix="help"
        label="Help topics"
        tabs={TOPICS}
        selected={tab}
        onSelect={(next) => {
          onViewChange(withTab(view, next));
        }}
      >
        {topic?.body.map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
      </Tabs>
    </div>
  );
}
