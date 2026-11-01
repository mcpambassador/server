import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { describe, it, expect } from 'vitest';
import { server } from '../mocks/server';
import { GroupDetail } from '../../pages/admin/GroupDetail';
import { McpDetail } from '../../pages/McpDetail';

// Headless UI's Listbox needs ResizeObserver, which jsdom lacks.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

const NOW = '2026-01-01T00:00:00Z';
const G = 'g1';

const grant = (id: string, over: Record<string, unknown> = {}) => ({
  mcp_id: id,
  name: id,
  display_name: `MCP ${id}`,
  transport_type: 'http',
  isolation_mode: 'shared',
  status: 'published',
  requires_user_credentials: false,
  config: {},
  tool_mode: 'all',
  tools: [],
  ...over,
});

type Put = { url: string; body: unknown };

function setup(grants: unknown[], known: Array<{ name: string; orphan: boolean }>, puts: Put[]) {
  server.use(
    http.get(`/v1/admin/groups/${G}`, () =>
      HttpResponse.json({
        ok: true,
        data: { group_id: G, name: 'Eng', created_at: NOW, updated_at: NOW },
      })
    ),
    http.get(`/v1/admin/groups/${G}/members`, () => HttpResponse.json({ ok: true, data: [] })),
    http.get(`/v1/admin/groups/${G}/mcps`, () => HttpResponse.json({ ok: true, data: grants })),
    http.get('/v1/admin/users', () => HttpResponse.json({ ok: true, data: [], pagination: {} })),
    http.get('/v1/admin/mcps', () => HttpResponse.json({ ok: true, data: [], pagination: {} })),
    http.get('/v1/admin/mcps/:mcpId/tools', ({ params }) =>
      HttpResponse.json({ ok: true, data: { mcp_id: params.mcpId, tools: known } })
    ),
    http.put(`/v1/admin/groups/${G}/mcps/:mcpId/tools`, async ({ request }) => {
      const body = await request.json();
      puts.push({ url: new URL(request.url).pathname, body });
      return HttpResponse.json({ ok: true, data: body });
    })
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/app/admin/groups/${G}`]}>
        <Routes>
          <Route path="/app/admin/groups/:groupId" element={<GroupDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

async function openMcps() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('tab', { name: 'MCPs' }));
  return user;
}

describe('group MCP grants: tool policy', () => {
  it('shows each grant’s tool mode in the list', async () => {
    setup(
      [
        grant('m1'),
        grant('m2', { tool_mode: 'allow', tools: ['a', 'b'] }),
        grant('m3', { tool_mode: 'deny', tools: ['x'] }),
      ],
      [],
      []
    );
    await openMcps();
    expect((await screen.findByTestId('tools-m1')).textContent).toBe('all tools');
    expect(screen.getByTestId('tools-m2').textContent).toBe('only 2');
    expect(screen.getByTestId('tools-m3').textContent).toBe('all except 1');
  });

  it('saves an allow list with PUT, sending exactly the ticked names', async () => {
    const puts: Put[] = [];
    setup(
      [grant('m1')],
      [
        { name: 'read', orphan: false },
        { name: 'write', orphan: false },
      ],
      puts
    );
    const user = await openMcps();
    await user.click(await screen.findByTestId('edit-policy-m1'));
    await user.click(await screen.findByTestId('mode-allow'));
    expect(screen.getByTestId('save-policy')).toBeDisabled(); // empty allow list
    expect(screen.getByTestId('empty-allow')).toBeInTheDocument();
    await user.click(await screen.findByTestId('tool-check-read'));
    await waitFor(() => expect(screen.getByTestId('save-policy')).toBeEnabled());
    await user.click(screen.getByTestId('save-policy'));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({
      url: `/v1/admin/groups/${G}/mcps/m1/tools`,
      body: { tool_mode: 'allow', tools: ['read'] },
    });
  });

  it('marks orphans and lets an admin untick them in deny mode', async () => {
    const puts: Put[] = [];
    setup(
      [grant('m1', { tool_mode: 'deny', tools: ['gone', 'write'] })],
      [
        { name: 'read', orphan: false },
        { name: 'write', orphan: false },
        { name: 'gone', orphan: true },
      ],
      puts
    );
    const user = await openMcps();
    await user.click(await screen.findByTestId('edit-policy-m1'));
    expect(await screen.findByTestId('orphan-gone')).toBeInTheDocument();
    expect(screen.queryByTestId('orphan-write')).not.toBeInTheDocument();
    expect(screen.getByTestId('tool-count').textContent).toContain('2 selected');
    await user.click(screen.getByTestId('tool-check-gone'));
    await user.click(screen.getByTestId('save-policy'));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.body).toEqual({ tool_mode: 'deny', tools: ['write'] });
  });

  it('clears the ticks when switching allow to deny, so a list never flips meaning', async () => {
    const puts: Put[] = [];
    setup(
      [grant('m1', { tool_mode: 'allow', tools: ['read'] })],
      [
        { name: 'read', orphan: false },
        { name: 'write', orphan: false },
      ],
      puts
    );
    const user = await openMcps();
    await user.click(await screen.findByTestId('edit-policy-m1'));
    expect(await screen.findByTestId('tool-count')).toHaveTextContent('1 selected');
    await user.click(screen.getByTestId('mode-deny'));
    expect(screen.getByTestId('selection-cleared')).toBeInTheDocument();
    expect(screen.getByTestId('tool-count')).toHaveTextContent('0 selected');
    expect(screen.getByTestId('tool-check-read')).not.toBeChecked();
    await user.click(screen.getByTestId('save-policy'));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.body).toEqual({ tool_mode: 'deny', tools: [] }); // never deny{read}
  });

  it('keeps this grant’s own rule names visible even if the picker does not list them', async () => {
    setup([grant('m1', { tool_mode: 'allow', tools: ['stale'] })], [], []);
    const user = await openMcps();
    await user.click(await screen.findByTestId('edit-policy-m1'));
    expect(await screen.findByTestId('orphan-stale')).toBeInTheDocument();
  });

  it('switching back to "all" sends an empty tools list', async () => {
    const puts: Put[] = [];
    setup(
      [grant('m1', { tool_mode: 'allow', tools: ['read'] })],
      [{ name: 'read', orphan: false }],
      puts
    );
    const user = await openMcps();
    await user.click(await screen.findByTestId('edit-policy-m1'));
    await user.click(await screen.findByTestId('mode-all'));
    expect(screen.queryByTestId('tool-picker')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('save-policy'));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.body).toEqual({ tool_mode: 'all', tools: [] });
  });

  it('shows invisible characters in tool names instead of hiding them', async () => {
    setup([grant('m1')], [{ name: `a${String.fromCharCode(0x202e)}b`, orphan: false }], []);
    const user = await openMcps();
    await user.click(await screen.findByTestId('edit-policy-m1'));
    await user.click(await screen.findByTestId('mode-deny'));
    expect(await screen.findByText(/⟨U\+202E⟩/)).toBeInTheDocument();
  });
});

describe('subscribe picker uses the marketplace effective tool set', () => {
  function renderMcp(tools: Array<{ name: string }>, posts: unknown[] = []) {
    server.use(
      http.get('/v1/marketplace/m1', () =>
        HttpResponse.json({
          ok: true,
          data: {
            id: 'm1',
            name: 'Github',
            isolationMode: 'shared',
            requiresUserCredentials: false,
            authType: 'none',
            tools,
            createdAt: NOW,
            updatedAt: NOW,
          },
        })
      ),
      http.get('/v1/users/me/clients', () =>
        HttpResponse.json({
          ok: true,
          data: [
            {
              id: 'c1',
              clientName: 'laptop',
              keyPrefix: 'amb_pk_x',
              status: 'active',
              createdAt: NOW,
            },
          ],
        })
      ),
      http.get('/v1/users/me/credentials', () => HttpResponse.json({ ok: true, data: [] })),
      http.post('/v1/users/me/clients/c1/subscriptions', async ({ request }) => {
        posts.push(await request.json());
        return HttpResponse.json({ ok: true, data: {} });
      })
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/app/marketplace/m1']}>
          <Routes>
            <Route path="/app/marketplace/:mcpId" element={<McpDetail />} />
            <Route path="/app/clients/:clientId" element={<div>client page</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
  }

  it('lists exactly the permitted tools and subscribes with a subset of them', async () => {
    const posts: unknown[] = [];
    renderMcp([{ name: 'read' }, { name: 'list' }], posts);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Subscribe to this MCP/ }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(await dialog.findByText('read')).toBeInTheDocument();
    expect(dialog.getByText('list')).toBeInTheDocument();
    expect(dialog.queryByText('write')).not.toBeInTheDocument();
    await user.click(dialog.getByText('list'));
    await user.click(dialog.getByRole('button', { name: /Select Client/ }));
    await user.click(await screen.findByRole('option', { name: /laptop/ }));
    await user.click(dialog.getByRole('button', { name: 'Subscribe' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ mcp_id: 'm1', selected_tools: ['read'] });
  });

  it('says so when no tool is permitted, and cannot subscribe', async () => {
    renderMcp([]);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Subscribe to this MCP/ }));
    expect(await screen.findByTestId('no-permitted-tools')).toBeInTheDocument();
    expect(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Subscribe' })
    ).toBeDisabled();
  });
});
