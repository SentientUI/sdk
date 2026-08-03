import { describe, it, expect } from 'vitest';
import { buildStyleOps } from './index';

describe('buildStyleOps', () => {
  it('maps friendly controls to whitelisted style keys', () => {
    const { style, errors } = buildStyleOps({ color: '#ff0000', fontSize: '18px', borderRadius: '8px', textAlign: 'center' });
    expect(style).toEqual({ color: '#ff0000', fontSize: '18px', borderRadius: '8px', textAlign: 'center' });
    expect(errors).toEqual({});
  });
  it('omits empty / undefined controls without flagging them as errors', () => {
    expect(buildStyleOps({ color: '', fontSize: undefined })).toEqual({ style: {}, errors: {} });
  });
  it('flags unsafe values (CSS injection guard) as errors, not silent drops', () => {
    const { style, errors } = buildStyleOps({ color: 'red;} body{display:none' });
    expect(style).toEqual({});
    expect(errors.color).toBeTruthy();
  });
  it('flags values that load an external resource via url()', () => {
    const { style, errors } = buildStyleOps({ background: 'url(https://tracker/x.png)' });
    expect(style).toEqual({});
    expect(errors.background).toBeTruthy();
  });
  it('keeps safe colour functions (rgb / hsl)', () => {
    const { style, errors } = buildStyleOps({ color: 'rgb(1,2,3)', background: 'hsl(1,2%,3%)' });
    expect(style).toEqual({ color: 'rgb(1,2,3)', background: 'hsl(1,2%,3%)' });
    expect(errors).toEqual({});
  });
});
