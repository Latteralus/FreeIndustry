import { render, screen } from '@testing-library/react';
import { App } from '../../../src/renderer/app/App';

describe('development shell', () => {
  it('states plainly that no simulation exists yet', () => {
    render(<App runtime={null} />);
    expect(
      screen.getByRole('heading', { name: 'FreeIndustry development shell' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Simulation: not implemented')).toBeInTheDocument();
  });

  it('reports runtime versions supplied by the preload bridge', () => {
    render(<App runtime={{ electron: '1.2.3', chrome: '4.5', node: '6.7.8' }} />);
    expect(screen.getByTestId('runtime-versions')).toHaveTextContent(
      'Electron 1.2.3 · Chromium 4.5 · Node 6.7.8',
    );
  });

  it('says so when the preload bridge is missing', () => {
    render(<App runtime={null} />);
    expect(screen.getByTestId('runtime-versions')).toHaveTextContent('Preload bridge unavailable');
  });
});
