import { describe, expect, it } from 'vitest';
import { mockSentientCypress } from './cypress';

describe('mockSentientCypress', () => {
  it('sets overrides on window:before:load and replies to /v1 from the scenario', async () => {
    let winCb: ((win: Record<string, unknown>) => void) | undefined;
    let interceptHandler: ((req: unknown) => unknown) | undefined;
    const cy = {
      on: (event: string, cb: (win: Record<string, unknown>) => void) => { if (event === 'window:before:load') winCb = cb; },
      intercept: (_p: string, handler: (req: unknown) => unknown) => { interceptHandler = handler; },
    };

    mockSentientCypress(cy as never, { variants: { hero: 'b' }, layout: ['a', 'b'] });

    const win: Record<string, unknown> = {};
    winCb!(win);
    expect(win.__sentient_overrides).toEqual({ hero: 'b' });
    expect(win.__sentient_layout_override).toEqual(['a', 'b']);

    let replied: { statusCode: number; body?: unknown } | undefined;
    await interceptHandler!({
      method: 'POST',
      url: 'https://api.sentient-ui.com/v1/decide',
      body: { sections: [{ id: 'a' }, { id: 'b' }] },
      reply: (r: { statusCode: number; body?: unknown }) => { replied = r; },
    });
    expect(replied!.statusCode).toBe(200);
    expect((replied!.body as { layoutOrder: string[] }).layoutOrder).toEqual(['a', 'b']);
  });
});
