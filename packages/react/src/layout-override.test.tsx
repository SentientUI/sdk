import { describe, expect, it, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useLayoutOrder } from './provider';

function Show() {
  const order = useLayoutOrder();
  return <div data-testid="lo">{order ? order.join(',') : 'null'}</div>;
}

describe('useLayoutOrder window override', () => {
  afterEach(() => {
    delete (window as unknown as { __sentient_layout_override?: unknown }).__sentient_layout_override;
  });

  it('returns the window layout override when set', () => {
    (window as unknown as { __sentient_layout_override?: string[] }).__sentient_layout_override = ['pricing', 'hero'];
    render(<Show />);
    expect(screen.getByTestId('lo').textContent).toBe('pricing,hero');
  });

  it('returns null (context default) when no override is set', () => {
    render(<Show />);
    expect(screen.getByTestId('lo').textContent).toBe('null');
  });
});
