// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { sampleStyleVocabulary } from './style-sample.js';

beforeEach(() => {
  document.body.innerHTML = `
    <section class="bg-gradient-to-br from-slate-800 to-slate-900 py-24" style="background-image: linear-gradient(rgb(30, 41, 59), rgb(15, 23, 42)); color: rgb(255,255,255)">
      <p class="text-xs uppercase tracking-widest text-blue-300" style="text-transform: uppercase; font-size: 12px; letter-spacing: 2px; color: rgb(147,197,253)">Independent specialist</p>
      <h1 class="text-4xl font-bold text-white" style="font-size: 40px; font-weight: 700; color: rgb(255,255,255)">Bodyshop Manchester</h1>
      <p class="text-lg text-gray-300" style="font-size: 18px; color: rgb(209,213,219)">Honest repairs.</p>
      <a href="/contact" class="px-8 py-3 bg-blue-600 text-white rounded-lg" style="display:inline-block; padding: 12px 32px; background-color: rgb(37,99,235); color: rgb(255,255,255); border-radius: 8px">Get in touch</a>
      <a href="/contact" class="px-8 py-3 bg-blue-600 text-white rounded-lg" style="display:inline-block; padding: 12px 32px; background-color: rgb(37,99,235); color: rgb(255,255,255); border-radius: 8px">Book</a>
      <a href="https://api.whatsapp.com/x" class="px-8 py-3 border border-white/20 text-white rounded-lg" style="display:inline-block; padding: 12px 32px; border: 1px solid rgba(255,255,255,0.2); color: rgb(255,255,255); border-radius: 8px">WhatsApp</a>
      <img class="rounded-xl" src="https://www.example.com/car.jpg" alt="Repaired Porsche" width="800" height="600">
    </section>`;
  document.body.style.fontSize = '16px';
});

describe('sampleStyleVocabulary', () => {
  it('clusters identical class lists and classifies by computed style', () => {
    const { entries } = sampleStyleVocabulary(document);
    const primary = entries.find((e) => e.role === 'button-primary')!;
    expect(primary.classes).toBe('px-8 py-3 bg-blue-600 text-white rounded-lg');
    expect(primary.seen.count).toBe(2);
    expect(primary.computed).toMatchObject({ bg: 'rgb(37, 99, 235)', color: 'rgb(255, 255, 255)', radius: '8px' });
    expect(entries.find((e) => e.role === 'button-secondary')!.classes).toContain('border-white/20');
    expect(entries.find((e) => e.role === 'heading-1')!.classes).toBe('text-4xl font-bold text-white');
    expect(entries.find((e) => e.role === 'eyebrow')).toBeDefined();
    expect(entries.find((e) => e.role === 'text-lead')!.classes).toBe('text-lg text-gray-300');
  });
  it('records a section gradient as its two stops', () => {
    const section = sampleStyleVocabulary(document).entries.find((e) => e.role === 'section')!;
    expect(section.computed.bg).toBe('rgb(15, 23, 42)');
    expect(section.computed.bgDark).toBe('rgb(30, 41, 59)'); // bg = darker stop, bgDark = the other stop (see implementation note)
  });
  it('collects site images with alt, same scheme, absolute src', () => {
    const { images } = sampleStyleVocabulary(document);
    expect(images).toEqual([expect.objectContaining({ src: 'https://www.example.com/car.jpg', alt: 'Repaired Porsche', w: 800, h: 600 })]);
  });
  it('skips elements with no class list and never throws on a hostile DOM', () => {
    document.body.innerHTML = '<a href="/">x</a><h1>y</h1>';
    expect(sampleStyleVocabulary(document).entries).toEqual([]);
  });
});

// What the live Bodyshop capture got wrong (2026-09-24).
describe('button sampling on a real page', () => {
  const size = (el: Element, w: number, h: number) =>
    Object.defineProperty(el, 'getBoundingClientRect', { value: () => ({ width: w, height: h, top: 0, left: 0, right: w, bottom: h, x: 0, y: 0, toJSON() {} }) });
  beforeEach(() => {
    document.body.style.backgroundColor = 'rgb(255, 255, 255)';
    document.body.innerHTML = `
      <section id="dark" style="background-color: rgb(15, 23, 42); color: rgb(255,255,255)">
        ${Array.from({ length: 6 }, (_, i) => `<a href="/m${i}" class="chip px-4 py-2 bg-slate-800/90" style="display:inline-block; padding: 8px 16px; background-color: rgba(29, 41, 61, 0.902)">Audi ${i}</a>`).join('')}
        ${Array.from({ length: 8 }, () => `<button class="icon p-2" style="padding: 8px"><svg></svg></button>`).join('')}
        <a href="/contact" class="cta px-8 py-3 bg-blue-600" style="display:inline-block; padding: 12px 32px; background-color: rgb(37, 99, 235); color: rgb(255,255,255)">Get in touch</a>
      </section>`;
    document.querySelectorAll('.chip').forEach((el) => size(el, 60, 36));
    size(document.querySelector('.cta')!, 190, 50);
  });

  it('the page CTA, seen once, outranks a chip repeated six times', () => {
    const { entries } = sampleStyleVocabulary(document);
    expect(entries.find((e) => e.id === 'button-primary')?.classes).toBe('cta px-8 py-3 bg-blue-600');
  });
  it('a translucent chip that barely stands out from its section is not a "main" button', () => {
    const { entries } = sampleStyleVocabulary(document);
    expect(entries.find((e) => e.classes.startsWith('chip'))?.role).toBe('button-secondary');
  });
  it('icon-only controls are not captured as buttons', () => {
    const { entries } = sampleStyleVocabulary(document);
    expect(entries.some((e) => e.classes === 'icon p-2')).toBe(false);
  });
});

describe('floating widgets and consent banners', () => {
  const size = (el: Element, w: number, h: number) =>
    Object.defineProperty(el, 'getBoundingClientRect', { value: () => ({ width: w, height: h, top: 0, left: 0, right: w, bottom: h, x: 0, y: 0, toJSON() {} }) });
  it('skips a small fixed pill and a CMP banner, keeps a full-width sticky header', () => {
    Object.defineProperty(window, 'innerWidth', { value: 1500, configurable: true });
    document.body.innerHTML = `
      <header id="hdr" style="position: sticky; top: 0"><a href="/q" class="hdr-cta px-4 bg-blue-500" style="display:inline-block; padding: 8px 16px; background-color: rgb(59, 130, 246); color: rgb(0,0,0)">Get a Quote</a></header>
      <button id="pill" class="fixed bottom-4 left-4 rounded-full" style="position: fixed; padding: 8px 16px; background-color: rgb(15, 23, 42); color: rgb(255,255,255)">Cookie settings</button>
      <div id="CybotCookiebotDialog"><button class="CybotCookiebotDialogBodyButton" style="padding: 8px 16px; background-color: rgb(20, 20, 200); color: rgb(255,255,255)">Allow all</button></div>`;
    size(document.getElementById('hdr')!, 1500, 80);
    size(document.getElementById('pill')!, 130, 34);
    const classes = sampleStyleVocabulary(document).entries.map((e) => e.classes);
    expect(classes).toContain('hdr-cta px-4 bg-blue-500');
    expect(classes).not.toContain('fixed bottom-4 left-4 rounded-full');
    expect(classes).not.toContain('CybotCookiebotDialogBodyButton');
  });
});
