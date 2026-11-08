import { fireEvent, render, screen, within } from '@testing-library/react';
import React, { act } from 'react';
import type { WindowView } from '../../../src/renderer/app/desktop/window-model';
import type { RequestOutcome } from '../../../src/renderer/app/useSimulationHost';
import { FactoryViewport } from '../../../src/renderer/scenes/FactoryViewport';
import { CitiesWindow } from '../../../src/renderer/windows/CitiesWindow';
import { CityWindow } from '../../../src/renderer/windows/CityWindow';
import { LeaseDialog, termOptions } from '../../../src/renderer/windows/LeaseDialog';
import { MainMenuWindow } from '../../../src/renderer/windows/MainMenuWindow';
import { NewWorldDialog } from '../../../src/renderer/windows/NewWorldDialog';
import { SAMPLE_COMPANY_VIEW } from '../../support/sample-company-view';
import {
  leasedRealEstate,
  sampleRealEstate,
  sampleScenarios,
} from '../../support/sample-real-estate';
import { must } from '../../support/must';

/**
 * Step 07 windows in jsdom: the city selection, the cityscape and its
 * property records, leasing, new worlds and the main menu. They only show
 * the worker's read model and send real commands.
 */

function Controlled({
  initial,
  render: renderWith,
}: {
  readonly initial: WindowView;
  readonly render: (view: WindowView, set: (view: WindowView) => void) => React.ReactNode;
}) {
  const [view, setView] = React.useState(initial);
  return <>{renderWith(view, setView)}</>;
}

describe('City View', () => {
  it('draws the district to scale with every building selectable, and shows the record of the one chosen', () => {
    const onLease = jest.fn();
    render(
      <Controlled
        initial={{}}
        render={(view, set) => (
          <CityWindow
            realEstate={sampleRealEstate()}
            units="us"
            view={view}
            onViewChange={set}
            onLease={onLease}
          />
        )}
      />,
    );
    const plan = screen.getByTestId('site-plan');
    expect(plan).toHaveAccessibleName('Site plan of Canal Street Works, drawn to scale');
    // Eight buildings in Canal Street Works; a garage is drawn far smaller than the old mill.
    expect(within(plan).getAllByRole('button')).toHaveLength(8);
    const garage = screen.getByTestId('building-hf-canal-2');
    expect(garage).toHaveAttribute('data-status', 'vacant');
    expect(garage).toHaveAccessibleName(
      '2 Canal Street (rear): Garage, 187 sq ft, $95.00 a month. Vacant.',
    );
    expect(screen.getByTestId('building-hf-canal-41')).toHaveAccessibleName(
      /Occupied by Ridley Furniture Co\.\.$/,
    );
    expect(screen.queryByTestId('property-inspector')).not.toBeInTheDocument();

    fireEvent.keyDown(screen.getByTestId('building-hf-canal-8'), { key: 'Enter' });
    const inspector = screen.getByTestId('property-inspector');
    expect(within(inspector).getByTestId('property-area')).toHaveTextContent('1,033 sq ft');
    expect(within(inspector).getByTestId('property-dimensions')).toHaveTextContent(
      '26 ft 3 in × 39 ft 4 in',
    );
    expect(within(inspector).getByTestId('property-rent')).toHaveTextContent(
      '$520.00 a month ($6.04 per sq ft a year)',
    );
    expect(within(inspector).getByTestId('property-upfront')).toHaveTextContent('$1,560.00');
    fireEvent.click(within(inspector).getByRole('button', { name: 'Lease…' }));
    expect(onLease).toHaveBeenCalledWith('hf-canal-8');

    // An occupied building cannot be leased, and says why.
    fireEvent.click(screen.getByTestId('building-hf-canal-12'));
    const lease = within(screen.getByTestId('property-inspector')).getByRole('button', {
      name: 'Lease…',
    });
    expect(lease).toBeDisabled();
    expect(lease).toHaveAttribute('title', '12 Canal Street is occupied by Brennan Sheet Metal.');
  });

  it('switches city and district, lists every property sortably, and lists the businesses', () => {
    render(
      <Controlled
        initial={{}}
        render={(view, set) => (
          <CityWindow
            realEstate={sampleRealEstate()}
            units="metric"
            view={view}
            onViewChange={set}
            onLease={jest.fn()}
          />
        )}
      />,
    );
    fireEvent.change(screen.getByLabelText('City'), { target: { value: 'port-calder' } });
    expect(screen.getByTestId('site-plan')).toHaveAccessibleName(
      'Site plan of Harbor Industrial Estate, drawn to scale',
    );
    fireEvent.change(screen.getByLabelText('District'), { target: { value: 'eastside-trade' } });
    expect(screen.getByTestId('building-pc-east-14')).toHaveAccessibleName(
      '14 Mercer Avenue (rear): Garage, 18.0 m², $140.00 a month. Vacant.',
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Listings' }));
    const table = screen.getByRole('table', { name: 'Properties in Port Calder' });
    expect(within(table).getAllByRole('row')).toHaveLength(14);
    fireEvent.click(within(table).getByRole('button', { name: 'Floor area' }));
    const first = within(table).getAllByRole('row')[1];
    expect(first).toHaveTextContent('14 Mercer Avenue (rear)');
    fireEvent.click(within(table).getByRole('button', { name: 'Inspect 5 Quay Road' }));
    expect(screen.getByRole('tab', { name: 'Site plan' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('property-area')).toHaveTextContent('5,400.0 m²');
    fireEvent.click(screen.getByRole('tab', { name: 'Directory' }));
    const directory = screen.getByRole('table', { name: 'Businesses in Port Calder' });
    expect(within(directory).getByText('Calder Steel Service')).toBeInTheDocument();
    expect(within(directory).getByText('Elsewhere in the city')).toBeInTheDocument();
  });

  it('says so for a world created before property existed', () => {
    render(
      <CityWindow
        realEstate={null}
        units="us"
        view={{}}
        onViewChange={jest.fn()}
        onLease={jest.fn()}
      />,
    );
    expect(screen.getByText(/created before cities and property existed/)).toBeInTheDocument();
  });
});

describe('City Selection', () => {
  it('compares the cities and opens the chosen one', () => {
    const onViewCity = jest.fn();
    render(
      <Controlled
        initial={{}}
        render={(view, set) => (
          <CitiesWindow
            realEstate={sampleRealEstate()}
            units="us"
            view={view}
            onViewChange={set}
            onViewCity={onViewCity}
          />
        )}
      />,
    );
    const harlow = screen.getByTestId('city-harlow-falls');
    expect(harlow).toHaveTextContent('186,000');
    expect(harlow).toHaveTextContent('6.8%');
    expect(harlow).toHaveTextContent('$11.20/h');
    expect(harlow).toHaveTextContent('$3.47 per sq ft a year');
    expect(harlow).toHaveTextContent('10 of 15');
    expect(harlow).toHaveTextContent('3 / 1 / 2');
    const map = screen.getByRole('group', { name: 'Regional map (schematic, not to scale)' });
    fireEvent.keyDown(within(map).getByRole('button', { name: 'Cedar Bluff, Texas' }), {
      key: 'Enter',
    });
    expect(screen.getByTestId('city-detail')).toHaveTextContent('Cedar Bluff, Texas');
    expect(screen.getByTestId('city-detail')).toHaveTextContent('Sunbelt Garden Tools');
    fireEvent.click(screen.getByRole('button', { name: 'View Cedar Bluff…' }));
    expect(onViewCity).toHaveBeenCalledWith('cedar-bluff');
  });
});

describe('Lease dialog', () => {
  const property = () => {
    const found = sampleRealEstate().properties.find((item) => item.id === 'hf-canal-8');
    if (!found) {
      throw new Error('fixture');
    }
    return found;
  };
  const accepted: RequestOutcome = {
    kind: 'accepted',
    worldRevision: 1,
    atMs: '0',
    duplicate: false,
  };

  it('lists only the terms the listing allows', () => {
    expect(termOptions(property())).toEqual([6, 12, 18, 24, 36]);
  });

  it('without a company, founds it and signs the lease in one command', async () => {
    const submit = jest.fn(() => Promise.resolve(accepted));
    const onLeased = jest.fn();
    render(
      <LeaseDialog
        property={property()}
        company={null}
        defaultCapitalCents="5000000"
        units="us"
        host={{ submit, pending: false }}
        onClose={jest.fn()}
        onLeased={onLeased}
      />,
    );
    const dialog = screen.getByTestId('lease-dialog');
    expect(within(dialog).getByTestId('lease-upfront')).toHaveTextContent(
      "$1,560.00: deposit $1,040.00 and the first month's rent",
    );
    const sign = within(dialog).getByRole('button', { name: 'Found company and sign lease' });
    expect(sign).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Company name'), {
      target: { value: 'Canal Works' },
    });
    fireEvent.change(within(dialog).getByLabelText('President'), { target: { value: 'Jo Canal' } });
    expect(within(dialog).getByLabelText('Starting capital ($)')).toHaveValue('50,000');
    fireEvent.change(within(dialog).getByLabelText('Lease term'), { target: { value: '24' } });
    fireEvent.click(within(dialog).getByLabelText('Standing order'));
    await act(async () => {
      fireEvent.click(sign);
      await Promise.resolve();
    });
    expect(submit).toHaveBeenCalledWith('company.found', {
      legalName: 'Canal Works',
      presidentName: 'Jo Canal',
      startingCapitalCents: '5000000',
      premises: { propertyId: 'hf-canal-8', termMonths: 24, standingOrder: false },
    });
    expect(onLeased).toHaveBeenCalled();
  });

  it('with a company, signs the lease and shows a refusal in words', async () => {
    const submit = jest.fn(() =>
      Promise.resolve<RequestOutcome>({
        kind: 'rejected',
        error: {
          code: 'COMMAND_REJECTED',
          message: 'Insufficient funds: $10.00 available, $1,560.00 needed',
        },
      }),
    );
    const company = SAMPLE_COMPANY_VIEW;
    render(
      <LeaseDialog
        property={property()}
        company={{ ...company, liquidity: { ...company.liquidity, availableCents: '1000' } }}
        defaultCapitalCents="5000000"
        units="us"
        host={{ submit, pending: false }}
        onClose={jest.fn()}
        onLeased={jest.fn()}
      />,
    );
    const dialog = screen.getByTestId('lease-dialog');
    expect(within(dialog).queryByLabelText('Company name')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'The funds do not cover what is due on signing',
    );
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Sign lease' }));
      await Promise.resolve();
    });
    expect(submit).toHaveBeenCalledWith('realEstate.lease', {
      propertyId: 'hf-canal-8',
      termMonths: 12,
      standingOrder: true,
    });
    expect(screen.getByTestId('lease-refusal')).toHaveTextContent(
      'Rejected (COMMAND_REJECTED): Insufficient funds',
    );
  });
});

describe('New Company and Scenarios', () => {
  it('starts the chosen scenario with an optional seed, and refuses a bad seed', () => {
    const onStart = jest.fn();
    render(
      <NewWorldDialog
        title="New Company"
        scenarios={sampleScenarios()}
        initialScenarioId="standard"
        unsavedChanges
        busy={false}
        onStart={onStart}
        onClose={jest.fn()}
      />,
    );
    expect(screen.getByRole('radio', { name: /Standard start/ })).toBeChecked();
    expect(screen.getByText(/autosaved before the new world starts/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('World seed (optional)'), { target: { value: '12x' } });
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('World seed (optional)'), {
      target: { value: '4294967296' },
    });
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('World seed (optional)'), { target: { value: '1996' } });
    fireEvent.click(screen.getByRole('radio', { name: /Backed start/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(onStart).toHaveBeenCalledWith('backed', 1996);
    fireEvent.click(screen.getByRole('radio', { name: /Quick Start/ }));
    fireEvent.change(screen.getByLabelText('World seed (optional)'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Quick Start' }));
    expect(onStart).toHaveBeenLastCalledWith('quick-start', null);
  });
});

describe('Main Menu', () => {
  it('offers New Company, Quick Start, Load, Scenarios, Options, Help and Exit, each doing something', () => {
    const actions = {
      newCompany: jest.fn(),
      quickStart: jest.fn(),
      load: jest.fn(),
      scenarios: jest.fn(),
      options: jest.fn(),
      help: jest.fn(),
      exit: jest.fn(),
    };
    render(
      <MainMenuWindow
        actions={actions}
        worldReady
        savesAvailable
        busy={false}
        company={null}
        realEstate={sampleRealEstate()}
        scenarios={sampleScenarios()}
      />,
    );
    expect(screen.getByTestId('main-menu-status')).toHaveTextContent(
      'No company has been founded in this world (Standard start).',
    );
    for (const [name, action] of [
      ['New Company…', actions.newCompany],
      ['Quick Start', actions.quickStart],
      ['Load…', actions.load],
      ['Scenarios…', actions.scenarios],
      ['Options…', actions.options],
      ['Help', actions.help],
      ['Exit', actions.exit],
    ] as const) {
      fireEvent.click(screen.getByRole('button', { name }));
      expect(action).toHaveBeenCalledTimes(1);
    }
  });
});

describe('Factory viewport', () => {
  it('draws the leased floor at a fixed scale: a garage small, a factory large, empty either way', () => {
    const estate = leasedRealEstate();
    const workshop = must(estate.properties.find((item) => item.id === 'hf-canal-8'));
    const factory = must(estate.properties.find((item) => item.id === 'pc-harbor-5'));
    const { rerender } = render(
      <FactoryViewport companyName="Canal Works" premises={workshop} units="us" />,
    );
    expect(screen.getByTestId('facility-caption')).toHaveTextContent(
      '8 Canal Street · Workshop, 1,033 sq ft · Empty: no equipment, staff or stock',
    );
    /** Drawn width of the floor outline itself, in pixels. */
    const floorWidth = () => {
      const polygon = screen.getByTestId('facility-floor-plan').querySelector('polygon');
      const xs = (polygon?.getAttribute('points') ?? '')
        .split(' ')
        .map((point) => Number(point.split(',')[0]));
      return Math.max(...xs) - Math.min(...xs);
    };
    expect(screen.getByTestId('facility-floor-plan')).toHaveAttribute(
      'data-pixels-per-metre',
      '10',
    );
    // 10 px a metre for every building: the 8 m workshop is 80 px wide, the 60 m factory 600 px.
    expect(floorWidth()).toBe(80);
    rerender(<FactoryViewport companyName="Canal Works" premises={factory} units="us" />);
    expect(floorWidth()).toBe(600);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByTestId('viewport-scale')).toHaveTextContent('20 px/m');
    expect(floorWidth()).toBe(1200);
    rerender(<FactoryViewport companyName="Canal Works" premises={null} units="us" />);
    expect(screen.getByText('No facility')).toBeInTheDocument();
  });
});
