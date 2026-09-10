import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { useState } from 'react';

import messages from '../../messages/en.json';
import { PasswordField } from './password-field';

/**
 * The one thing this component does that a plain input does not: let somebody
 * read back what they typed. Hiding a password defends against the person
 * behind you and causes the typo you cannot see, so both states have to work
 * and both have to be announced.
 */
function Harness() {
  const [value, setValue] = useState('');

  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      <PasswordField
        aria-label="Password"
        onChange={(event) => setValue(event.target.value)}
        value={value}
      />
    </NextIntlClientProvider>
  );
}

describe('PasswordField', () => {
  it('hides what is typed until asked', () => {
    render(<Harness />);

    expect(screen.getByLabelText('Password')).toHaveProperty(
      'type',
      'password',
    );
  });

  it('reveals it, and says which state it is in', () => {
    render(<Harness />);

    const reveal = screen.getByRole('button', {
      name: messages.auth.showPassword,
    });
    expect(reveal.getAttribute('aria-pressed')).toBe('false');

    // fireEvent rather than a raw DOM click: the state change has to happen
    // inside React's update cycle or the rerender never runs.
    fireEvent.click(reveal);

    // The same control, now labelled for what it will do next — a screen
    // reader announces the state rather than leaving it to be guessed.
    const hide = screen.getByRole('button', {
      name: messages.auth.hidePassword,
    });
    expect(hide.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByLabelText('Password')).toHaveProperty('type', 'text');
  });
});
