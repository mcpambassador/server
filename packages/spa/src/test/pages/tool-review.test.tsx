import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { describe, it, expect } from 'vitest';
import { server } from '../mocks/server';
import { ToolReview } from '../../pages/admin/ToolReview';
import { PinPolicyCard } from '../../components/admin/PinPolicyCard';
import { visibleText, splitAtCodePoints, lineDiff } from '../../lib/pin-text';
import { NON_APPROVABLE_FLAGS } from '../../api/tool-pin-types';
import { TOOL_PIN_BLOCKING_FLAG_CODES } from '@mcpambassador/contracts';

const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);

const pin = (over: Record<string, unknown> = {}) => ({
  pin_id: 'p1',
  mcp_id: 'm1',
  mcp_name: 'github',
  scope_user_id: null,
  tool_name: 'create_issue',
  status: 'pending_review',
  approved_hash: H1,
  pending_hash: H2,
  flags: { rules_version: 1, codes: [] },
  absent: false,
  baseline_unreviewed: false,
  first_seen_at: '2026-01-01T00:00:00Z',
  approved_at: null,
  approved_by: null,
  updated_at: '2026-01-01T00:00:00Z',
  ...over,
});

const list = (rows: unknown[]) => ({
  ok: true,
  data: rows,
  pagination: { has_more: false, next_cursor: null, total_count: rows.length },
});

function setup(opts: {
  pending?: unknown[];
  baseline?: unknown[];
  detail?: Record<string, unknown>;
  posts?: Array<{ url: string; body: unknown }>;
}) {
  const posts = opts.posts ?? [];
  server.use(
    http.get('/v1/admin/tool-pins/summary', () =>
      HttpResponse.json({
        ok: true,
        data: {
          pending_count: opts.pending?.length ?? 0,
          baseline_unreviewed_count: opts.baseline?.length ?? 0,
          held_mcps: [],
        },
      })
    ),
    http.get('/v1/admin/tool-pins', ({ request }) => {
      const q = new URL(request.url).searchParams;
      return HttpResponse.json(
        list(q.get('baseline') ? (opts.baseline ?? []) : (opts.pending ?? []))
      );
    }),
    http.get('/v1/admin/tool-pins/:id', () =>
      HttpResponse.json({ ok: true, data: opts.detail ?? {} })
    ),
    http.post('/v1/admin/tool-pins/:id/:action', async ({ request }) => {
      posts.push({ url: new URL(request.url).pathname, body: await request.json() });
      return HttpResponse.json({ ok: true, data: {} });
    })
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ToolReview />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return posts;
}

describe('pin-text helpers', () => {
  it('makes zero-width and bidi characters visible, keeps newlines', () => {
    expect(visibleText('a​b‮c\nd')).toBe('a⟨U+200B⟩b⟨U+202E⟩c\nd');
  });
  it('splits at code points, not UTF-16 units', () => {
    const { head, tail } = splitAtCodePoints('😀😀😀', 2);
    expect(head).toBe('😀😀');
    expect(tail).toBe('😀');
  });
  it('diffs by line', () => {
    expect(lineDiff('a\nb', 'a\nc').ops.map(o => o.kind)).toEqual(['same', 'del', 'add']);
  });
});

describe('blocking flags', () => {
  it('covers every contract blocking code', () => {
    for (const c of TOOL_PIN_BLOCKING_FLAG_CODES) expect(NON_APPROVABLE_FLAGS).toContain(c);
  });
});

describe('ToolReview', () => {
  it('shows pending pins grouped with flag codes and reveals hidden characters', async () => {
    setup({
      pending: [
        pin({
          tool_name: 'ev​il',
          flags: { rules_version: 1, codes: ['hidden_unicode', 'weird<code>'] },
        }),
      ],
    });
    expect(await screen.findByText('ev⟨U+200B⟩il')).toBeInTheDocument();
    expect(screen.getByTestId('flag-hidden_unicode')).toBeInTheDocument();
    expect(screen.getByText('weird<code>')).toBeInTheDocument();
  });

  it('approves with expected_hash = pending_hash and apply_to all_users for a user-scoped pin', async () => {
    const user = userEvent.setup();
    const posts = setup({
      pending: [pin({ scope_user_id: 'u1' })],
      detail: {
        ...pin({ scope_user_id: 'u1' }),
        approved_definition: { name: 'create_issue', description: 'old' },
        pending_definition: { name: 'create_issue', description: 'new' },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    await screen.findByTestId('pin-diff');
    expect(screen.getByTestId('pin-diff').textContent).toContain('- old');
    expect(screen.getByTestId('pin-diff').textContent).toContain('+ new');
    await user.click(screen.getByRole('checkbox', { name: /Apply to all users/ }));
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      url: '/v1/admin/tool-pins/p1/approve',
      body: { expected_hash: H2, apply_to: 'all_users' },
    });
  });

  it('sends reject with the reason', async () => {
    const user = userEvent.setup();
    const posts = setup({
      pending: [pin()],
      detail: { ...pin(), approved_definition: null, pending_definition: { name: 'x' } },
    });
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    await screen.findByTestId('pin-diff');
    await user.type(screen.getByRole('textbox'), 'looks injected');
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      url: '/v1/admin/tool-pins/p1/reject',
      body: { expected_hash: H2, reason: 'looks injected' },
    });
  });

  it('disables approve for reserved_name', async () => {
    const user = userEvent.setup();
    const flags = { rules_version: 1, codes: ['reserved_name'] };
    setup({
      pending: [pin({ flags })],
      detail: {
        ...pin({ flags }),
        approved_definition: null,
        pending_definition: { name: 'ambassador__x' },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    await screen.findByTestId('pin-diff');
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeEnabled();
  });

  it('shows only a size marker for an oversize definition and never approves it', async () => {
    const user = userEvent.setup();
    const flags = { rules_version: 1, codes: ['canonical_too_large'] };
    setup({
      pending: [pin({ flags })],
      detail: {
        ...pin({ flags }),
        approved_definition: null,
        pending_definition: { name: 'big', description: 'SECRET-BODY' },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    await screen.findByTestId('oversize-marker');
    expect(screen.queryByText(/SECRET-BODY/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
  });

  it('shows the agent-visible 500 code points with a cut marker', async () => {
    const user = userEvent.setup();
    const desc = 'x'.repeat(500) + 'TAILTEXT';
    setup({
      pending: [pin()],
      detail: {
        ...pin(),
        approved_definition: null,
        pending_definition: { name: 'create_issue', description: desc },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    const av = await screen.findByTestId('agent-visible');
    expect(within(av).getByText(/cut here/)).toBeInTheDocument();
    expect(av.textContent).toContain('508 code points');
  });

  it('renders icons as text, never as images', async () => {
    const user = userEvent.setup();
    setup({
      pending: [pin()],
      detail: {
        ...pin(),
        approved_definition: null,
        pending_definition: {
          name: 'create_issue',
          icons: [{ src: 'https://evil.example/t.png', mimeType: 'image/png' }],
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    await screen.findByTestId('pin-diff');
    expect(screen.getByTestId('pin-diff').textContent).toContain('src=https://evil.example/t.png');
    expect(document.querySelector('img')).toBeNull();
  });

  it('confirms a baseline pin with expected_hash = approved_hash', async () => {
    const user = userEvent.setup();
    const b = pin({ status: 'approved', pending_hash: null, baseline_unreviewed: true });
    const posts = setup({
      baseline: [b],
      detail: { ...b, approved_definition: { name: 'create_issue' }, pending_definition: null },
    });
    await user.click(await screen.findByRole('button', { name: /Baseline, never human-reviewed/ }));
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm baseline' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      url: '/v1/admin/tool-pins/p1/confirm-baseline',
      body: { expected_hash: H1 },
    });
  });
});

describe('ToolReview truncation', () => {
  it('keeps Approve disabled until a long definition is expanded; hidden text is reachable', async () => {
    const user = userEvent.setup();
    const desc = 'y'.repeat(1500) + 'INJECT-MARKER' + 'z'.repeat(487);
    const posts = setup({
      pending: [pin()],
      detail: {
        ...pin(),
        approved_definition: null,
        pending_definition: { name: 'create_issue', description: desc },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    await screen.findByTestId('pin-diff');
    expect(screen.getByTestId('pin-diff').textContent).toContain('[line truncated');
    expect(screen.getByTestId('pin-diff').textContent).not.toContain('INJECT-MARKER');
    expect(screen.getByTestId('truncation-warning')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /Show all/ }));
    expect(screen.getByTestId('pin-full').textContent).toContain('INJECT-MARKER');
    expect(screen.queryByTestId('truncation-warning')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(posts).toHaveLength(1));
  });

  it('does not deadlock on a 601-2000 character line: it is shown in full and Approve is enabled', async () => {
    const user = userEvent.setup();
    const posts = setup({
      pending: [pin()],
      detail: {
        ...pin(),
        approved_definition: null,
        pending_definition: { name: 'create_issue', description: 'q'.repeat(800) },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    await screen.findByTestId('pin-diff');
    expect(screen.getByTestId('pin-diff').textContent).toContain('[line truncated');
    expect(screen.getByTestId('pin-full').textContent).toContain('q'.repeat(800));
    expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull();
    expect(screen.queryByTestId('truncation-warning')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(posts).toHaveLength(1));
  });

  it('marks a diff cut at 400 lines', async () => {
    const user = userEvent.setup();
    const schema = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i]));
    setup({
      pending: [pin()],
      detail: {
        ...pin(),
        approved_definition: null,
        pending_definition: { name: 'create_issue', inputSchema: schema },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    await screen.findByTestId('pin-diff');
    expect(screen.getByTestId('pin-diff').textContent).toContain('[diff truncated:');
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
  });
});

describe('PinPolicyCard', () => {
  function renderCard(policy?: 'review' | 'auto', origin: string = 'custom') {
    const patches: unknown[] = [];
    server.use(
      http.patch('/v1/admin/mcps/m1/pin-policy', async ({ request }) => {
        patches.push(await request.json());
        return HttpResponse.json({ ok: true, data: {} });
      })
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <PinPolicyCard mcpId="m1" policy={policy} origin={origin} />
      </QueryClientProvider>
    );
    return patches;
  }

  it('defaults to review and requires confirmation, with a warning, before auto', async () => {
    const user = userEvent.setup();
    const patches = renderCard();
    expect(screen.getByTestId('pin-policy-badge')).toHaveTextContent('review');
    await user.click(screen.getByRole('button', { name: 'Switch to auto' }));
    expect(within(await screen.findByRole('dialog')).getByText(/unseen/)).toBeInTheDocument();
    expect(patches).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Use auto' }));
    await waitFor(() => expect(patches).toEqual([{ pin_policy: 'auto' }]));
  });

  it('hides auto for registry MCPs', () => {
    renderCard('review', 'registry');
    expect(screen.queryByRole('button', { name: 'Switch to auto' })).toBeNull();
    expect(screen.getByTestId('auto-unavailable')).toBeInTheDocument();
  });

  it('switches back to review without a prompt', async () => {
    const user = userEvent.setup();
    const patches = renderCard('auto');
    await user.click(screen.getByRole('button', { name: 'Switch to review' }));
    await waitFor(() => expect(patches).toEqual([{ pin_policy: 'review' }]));
  });
});
