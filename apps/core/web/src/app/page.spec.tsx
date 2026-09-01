import { render, screen } from '@testing-library/react';

import Index from './page';

describe('Index page', () => {
  it('renders the application heading', () => {
    render(<Index />);

    expect(screen.getByTestId('app-heading').textContent).toBe('core-web');
  });

  it('renders the shared design-system button', () => {
    render(<Index />);

    expect(
      screen.getByRole('button', { name: 'Shared design system' }),
    ).toBeTruthy();
  });
});
