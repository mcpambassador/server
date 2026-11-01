import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { describe, it, expect } from 'vitest';
import { server } from '../mocks/server';
import { KillSwitches } from '../../pages/admin/KillSwitches';

const page = (rows: unknown[]) => ({
  ok: true,
  data: rows,
  pagination: { has_more: false, next_cursor: null, total_count: rows.length },
});

const clients = [
  {
    client_id: 'c1',
    client_name: 'Laptop',
    key_prefix: 'amb_pk_aaaa',
    owner_user_id: 'u1',
    status: 'active',
    created_at: '2026-01-01T00:00:00Z',
  },
  {
    client_id: 'c2',
    client_name: 'Phone',
    key_prefix: 'amb_pk_bbbb',
    owner_user_id: 'u1',
    status: 'suspended',
    created_at: '2026-01-01T00:00:00Z',
  },
];
const mcps = [
  { mcp_id: 'm1', name: 'github', display_name: 'GitHub', status: 'published' },
  { mcp_id: 'm2', name: 'slack', display_name: 'Slack', status: 'draft' },
];

function setup(switches: unknown, posts: Array<{ url: string; body: unknown }> = []) {
  server.use(
    http.get('/v1/admin/clients', () => HttpResponse.json(page(clients))),
    http.get('/v1/admin/mcps', () => HttpResponse.json(page(mcps))),
    http.get('/v1/admin/kill-switches', () =>
      switches === 'error'
        ? HttpResponse.json({ ok: false, error: { code: 'x', message: 'boom' } }, { status: 500 })
        : HttpResponse.json({ ok: true, data: switches })
    ),
    http.post('/v1/admin/kill-switch/:target', async ({ request }) => {
      posts.push({ url: new URL(request.url).pathname, body: await request.json() });
      return HttpResponse.json({ ok: true, data: { target: 'x', enabled: true, timestamp: 't' } });
    })
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <KillSwitches />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('KillSwitches', () => {
  it('Kill on a live client sends enabled:true, regardless of client status', async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    setup([], posts);
    // Suspended client with no active switch must also say "Kill", not "Enable"
    const killButtons = await screen.findAllByRole('button', { name: 'Kill' });
    expect(killButtons).toHaveLength(4); // 2 clients + 2 MCPs, none killed
    expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull();

    await userEvent.click(killButtons[0]);
    await userEvent.click(await screen.findByRole('button', { name: 'Activate kill switch' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.url).toBe('/v1/admin/kill-switch/client:c1');
    expect(posts[0]?.body).toEqual({ enabled: true });
  });

  it('button labels follow the active list; Restore sends enabled:false', async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    setup(
      [
        { key: 'mcp:slack', active: true }, // draft MCP, killed
        { key: 'client:c2', active: true }, // suspended client, killed
        { key: 'client:c1', active: false },
      ],
      posts
    );
    const restore = await screen.findAllByRole('button', { name: 'Restore' });
    expect(restore).toHaveLength(2);
    expect(screen.getAllByText('Kill switch active')).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Kill' })).toHaveLength(2);

    await userEvent.click(restore[0]); // client:c2 renders first
    await userEvent.click(await screen.findByRole('button', { name: 'Restore access' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.url).toBe('/v1/admin/kill-switch/client:c2');
    expect(posts[0]?.body).toEqual({ enabled: false });
  });

  it('disables controls when kill-switch state cannot be loaded', async () => {
    setup('error');
    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not load kill-switch state/);
    for (const b of screen.getAllByRole('button', { name: 'Kill' })) expect(b).toBeDisabled();
  });
});
