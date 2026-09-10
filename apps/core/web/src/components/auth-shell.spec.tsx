import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import messages from '../../messages/en.json';
import { AuthShell } from './auth-shell';

/**
 * The frame every credential screen sits in. It is worth a test because each
 * screen hands it a different title, description and footer — a frame that
 * dropped one of them would look fine and say nothing.
 */
function renderShell() {
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AuthShell description="A description" footer={<span>A footer</span>} title="A title">
        <p>The form</p>
      </AuthShell>
    </NextIntlClientProvider>,
  );
}

describe('AuthShell', () => {
  it('shows everything the screen handed it', () => {
    renderShell();

    expect(screen.getByRole('heading', { name: 'A title' })).toBeTruthy();
    expect(screen.getByText('A description')).toBeTruthy();
    expect(screen.getByText('The form')).toBeTruthy();
    expect(screen.getByText('A footer')).toBeTruthy();
  });

  it('leaves the logo out of the accessible name', () => {
    renderShell();

    // The heading already carries the name; announcing the logo as well would
    // read it twice.
    const logo = document.querySelector('img');

    expect(logo?.getAttribute('alt')).toBe('');
  });
});
