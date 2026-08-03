import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithSentient, setupSentientTests } from './index';
import { Adaptive } from '../adaptive.js';

function Demo() {
  return (
    <Adaptive
      id="hero"
      goal="signup"
      variants={{ control: <span>Control</span>, b: <span>Variant B</span> }}
    />
  );
}

describe('renderWithSentient', () => {
  it('renders the control variant by default, no network', () => {
    renderWithSentient(<Demo />);
    expect(screen.getByText('Control')).toBeTruthy();
  });

  it('forces a variant via scenario', () => {
    renderWithSentient(<Demo />, { variants: { hero: 'b' } });
    expect(screen.getByText('Variant B')).toBeTruthy();
  });

  it('setupSentientTests does not throw', () => {
    expect(() => setupSentientTests()).not.toThrow();
  });
});
