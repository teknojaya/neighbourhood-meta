import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';

vi.mock('../../lib/firebase', () => ({ getFirebaseAuth: () => null }));
const { MatchList } = await import('./NeedMatches');

type Props = Parameters<typeof MatchList>[0];
const item = {
  listing: { id: '00000000-0000-4000-8000-000000000001', title: 'Rice cooker', mode: 'donate', condition: 'like_new', stock: { total: 3, reserved: 1, collected: 0 }, location: { areaLabel: 'Menteng', distanceKm: 1.2 } },
  fit: 'partial', reason: 'A rice cooker nearby.', missingInfo: ['Size'],
} as unknown as Props['items'][number];
const render = (explanationSource?: Props['explanationSource']) => renderToStaticMarkup(<MemoryRouter><MatchList items={[item]} explanationSource={explanationSource} /></MemoryRouter>);

describe('MatchList provenance labels', () => {
  it('shows verified listing facts in every state', () => {
    for (const source of ['model', 'filters', undefined] as const) expect(render(source)).toContain('like new · 2 available · about 1.2 km');
  });
  it('labels only model output as an AI explanation', () => {
    expect(render('model')).toContain('AI explanation');
    expect(render('filters')).toContain('not ranked or explained by AI');
    expect(render('filters')).not.toContain('AI explanation');
  });
  it('uses a neutral label when an older card did not record its source', () => {
    const html = render(undefined);
    expect(html).toContain('source not recorded');
    expect(html).not.toContain('AI explanation');
    expect(html).not.toContain('not ranked or explained by AI');
  });
});
