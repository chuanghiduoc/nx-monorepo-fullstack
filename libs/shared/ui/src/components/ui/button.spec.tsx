import { render, screen } from '@testing-library/react';

import { Button } from './button';

describe('Button', () => {
  it('renders its children', () => {
    render(<Button>Save</Button>);

    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
  });

  it('merges caller classes with the variant classes', () => {
    render(<Button className="w-full">Save</Button>);

    const button = screen.getByRole('button', { name: 'Save' });

    expect(button.className).toContain('w-full');
    expect(button.className).toContain('inline-flex');
  });

  it('renders as a child element when asChild is set', () => {
    render(
      <Button asChild>
        <a href="/docs">Docs</a>
      </Button>,
    );

    const link = screen.getByRole('link', { name: 'Docs' });

    expect(link.tagName).toBe('A');
    expect(link.className).toContain('inline-flex');
  });
});
