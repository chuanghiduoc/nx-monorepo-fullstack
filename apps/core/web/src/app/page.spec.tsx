import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import messages from '../../messages/en.json';
import Home from './page';

/**
 * Rendered through the provider, in one language, so the assertions are about
 * the page rather than about whichever catalogue happens to be the default.
 */
function renderHome() {
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <Home />
    </NextIntlClientProvider>,
  );
}

describe('the front page', () => {
  it('names the application', () => {
    renderHome();

    expect(screen.getByTestId('app-heading').textContent).toBe(
      messages.home.title,
    );
  });

  it('offers the two ways in and nothing else', () => {
    renderHome();

    // `getAttribute` rather than a DOM matcher: this suite does not load
    // jest-dom, and a missing matcher fails as "invalid property" rather than
    // as the assertion it was meant to be.
    const signIn = screen.getByRole('link', { name: messages.home.signIn });
    const signUp = screen.getByRole('link', { name: messages.home.signUp });

    expect(signIn.getAttribute('href')).toBe('/sign-in');
    expect(signUp.getAttribute('href')).toBe('/sign-up');
    expect(screen.getAllByRole('link')).toHaveLength(2);
  });
});
