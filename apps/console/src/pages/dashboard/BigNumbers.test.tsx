// @vitest-environment happy-dom
// Hiccups tile (#2587): policy holds are not hiccups, but the tile still says how many
// jobs Curia held for the principal, so a careful week is visible without reading as broken.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { StatsData } from './dashboard-utils.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ stats: null as StatsData | null }));

vi.mock('./dashboard-utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./dashboard-utils.js')>()),
  fetchStats: vi.fn(async () => mocks.stats),
}));
vi.mock('./HiccupsDialog.js', () => ({ HiccupsDialog: () => null }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, className }: { children: ReactNode; className?: string }) => <a className={className}>{children}</a>,
}));

const { BigNumbers } = await import('./BigNumbers.js');

function stats(held: number, hiccups: number): StatsData {
  return {
    timezone: 'UTC',
    minutesSaved: { current: 30, previous: 20, help: 'help', detail: 'detail' },
    done: { current: 5, previous: 4 },
    openTasks: { total: 1, overdue: 0 },
    hiccups: { current: hiccups, byDay: [0, hiccups] },
    held: { current: held },
    handledSinceYesterday: 2,
  };
}

let root: Root | null = null;
let container: HTMLElement;

async function mount(data: StatsData): Promise<HTMLElement> {
  mocks.stats = data;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(<BigNumbers onHandled={() => {}} onTimezone={() => {}} />); });
  await act(async () => { await new Promise(r => setTimeout(r, 20)); });
  const tile = [...container.querySelectorAll('article')].find(a => a.textContent?.includes('Hiccups'));
  return tile as HTMLElement;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
});

describe('Hiccups tile', () => {
  it('shows held-for-you jobs beside the hiccup number, not in it', async () => {
    const tile = await mount(stats(3, 1));
    expect(tile.querySelector('.dash-num-value')?.textContent).toBe('1');
    expect(tile.textContent).toContain('3 held for you');
  });

  it('says nothing about holds in a week with none', async () => {
    const tile = await mount(stats(0, 2));
    expect(tile.textContent).not.toContain('held for you');
  });
});
