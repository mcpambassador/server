import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { server } from '../mocks/server';
import { OAuthConsent } from '../../pages/OAuthConsent';
import { AgentAccess } from '../../pages/AgentAccess';
import { AgentEndpoint } from '../../pages/admin/AgentEndpoint';
import { returnToPath, safeRedirectUrl } from '../../lib/return-to';
import { grantStatus, parseToolAllowlist, ttlOptions } from '../../api/agent-types';

function renderAt(ui: React.ReactElement, route: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

const ok = (data: unknown) => HttpResponse.json({ ok: true, data });
const err = (status: number, code: string, message: string) =>
  HttpResponse.json({ ok: false, error: { code, message } }, { status });

const details = {
  client_name: 'Acme Agent',
  client_verified: false,
  requested_scopes: ['mcp:github'],
  clients: [
    {
      client_id: 'c1',
      client_name: 'Laptop',
      profile_name: null,
      subscriptions: [
        { name: 'github', scope: 'mcp:github' },
        { name: 'slack', scope: 'mcp:slack' },
      ],
    },
    {
      client_id: 'c2',
      client_name: 'CI box',
      profile_name: 'ci',
      subscriptions: [{ name: 'jira', scope: 'mcp:jira' }],
    },
  ],
  default_ttl_seconds: 3600,
  max_ttl_seconds: 86400,
};

describe('helpers', () => {
  it('returnToPath only allows in-app paths', () => {
    expect(
      returnToPath({ from: { pathname: '/app/oauth/consent', search: '?request_id=r1' } })
    ).toBe('/app/oauth/consent?request_id=r1');
    expect(returnToPath({ from: { pathname: '//evil.com' } })).toBe('/app/dashboard');
    expect(returnToPath({ from: { pathname: '/login' } })).toBe('/app/dashboard');
    expect(returnToPath(null)).toBe('/app/dashboard');
  });
  it('safeRedirectUrl allows https and loopback http only', () => {
    expect(safeRedirectUrl('https://agent.example/cb?code=1')).not.toBeNull();
    expect(safeRedirectUrl('http://127.0.0.1:8123/cb')).not.toBeNull();
    expect(safeRedirectUrl('http://localhost:9/cb')).not.toBeNull();
    expect(safeRedirectUrl('http://[::1]:9/cb')).not.toBeNull();
    expect(safeRedirectUrl('http://evil.example/cb')).toBeNull();
    expect(safeRedirectUrl('javascript:alert(1)')).toBeNull();
    expect(safeRedirectUrl('myapp://cb')).toBeNull();
    expect(safeRedirectUrl('not a url')).toBeNull();
  });
  it('parses allowlists, statuses and ttl options', () => {
    expect(parseToolAllowlist(' a.b,\n c.d\na.b ')).toEqual(['a.b', 'c.d']);
    expect(parseToolAllowlist('  ')).toBeUndefined();
    const past = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 100000).toISOString();
    expect(grantStatus({ revoked_at: null, expires_at: past })).toBe('expired');
    expect(grantStatus({ revoked_at: past, expires_at: future })).toBe('revoked');
    expect(grantStatus({ revoked_at: null, expires_at: future })).toBe('active');
    const opts = ttlOptions(3600, 7200).map(o => o.seconds);
    expect(opts).toEqual([900, 3600, 7200]);
  });
});

describe('OAuthConsent', () => {
  beforeEach(() => {
    server.use(http.get('/v1/oauth/consent/r1', () => ok(details)));
  });

  it('shows unverified warning, preselects requested scopes, and posts approval with CSRF', async () => {
    let body: unknown;
    let csrf: string | null = null;
    server.use(
      http.post('/v1/oauth/consent/r1', async ({ request }) => {
        body = await request.json();
        csrf = request.headers.get('x-csrf-token');
        return ok({ redirect_url: 'http://localhost:9/cb?code=c&state=s' });
      })
    );
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });

    renderAt(<OAuthConsent />, '/app/oauth/consent?request_id=r1');
    expect(await screen.findByText('Unverified client')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/not been verified/);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith('http://localhost:9/cb?code=c&state=s')
    );
    expect(csrf).toBe('test-csrf-token');
    expect(body).toMatchObject({
      decision: 'approve',
      bound_client_id: 'c1',
      scopes: ['mcp:github'],
      ttl_seconds: 3600,
    });
    vi.unstubAllGlobals();
  });

  it('switching client swaps the scope list and binds the chosen client', async () => {
    let body: unknown;
    server.use(
      http.post('/v1/oauth/consent/r1', async ({ request }) => {
        body = await request.json();
        return ok({ redirect_url: 'http://localhost:9/cb?code=c' });
      })
    );
    vi.stubGlobal('location', { ...window.location, assign: vi.fn() });
    renderAt(<OAuthConsent />, '/app/oauth/consent?request_id=r1');
    const user = userEvent.setup();
    await user.selectOptions(
      await screen.findByRole('combobox', { name: /Ambassador client/ }),
      'c2'
    );
    expect(screen.queryByRole('checkbox', { name: 'github' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('checkbox', { name: 'jira' }));
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(body).toMatchObject({
        decision: 'approve',
        bound_client_id: 'c2',
        scopes: ['mcp:jira'],
      })
    );
    vi.unstubAllGlobals();
  });

  it('shows a zero-state with a link when the user has no clients', async () => {
    server.use(http.get('/v1/oauth/consent/r1', () => ok({ ...details, clients: [] })));
    renderAt(<OAuthConsent />, '/app/oauth/consent?request_id=r1');
    expect(await screen.findByText(/no active Ambassador clients/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create a client' })).toHaveAttribute(
      'href',
      '/app/clients'
    );
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
  });

  it('refuses to navigate to a disallowed redirect_url and shows the host', async () => {
    server.use(
      http.get('/v1/oauth/consent/r1', () =>
        ok({ ...details, redirect_uri_host: 'agent.example' })
      ),
      http.post('/v1/oauth/consent/r1', () => ok({ redirect_url: 'javascript:alert(1)' }))
    );
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    renderAt(<OAuthConsent />, '/app/oauth/consent?request_id=r1');
    expect(await screen.findByText('agent.example')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText(/redirect address that is not allowed/)).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('deny sends no scopes', async () => {
    let body: unknown;
    server.use(
      http.post('/v1/oauth/consent/r1', async ({ request }) => {
        body = await request.json();
        return ok({ redirect_url: 'http://localhost:9/cb?error=access_denied' });
      })
    );
    vi.stubGlobal('location', { ...window.location, assign: vi.fn() });
    renderAt(<OAuthConsent />, '/app/oauth/consent?request_id=r1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(body).toMatchObject({ decision: 'deny', scopes: [] }));
    vi.unstubAllGlobals();
  });

  it('disables Approve when nothing is selected and explains expired requests', async () => {
    server.use(http.get('/v1/oauth/consent/gone', () => err(404, 'NOT_FOUND', 'nope')));
    renderAt(<OAuthConsent />, '/app/oauth/consent?request_id=gone');
    expect(await screen.findByRole('alert')).toHaveTextContent(/expired or was already used/);
  });

  it('requires a request_id', () => {
    renderAt(<OAuthConsent />, '/app/oauth/consent');
    expect(screen.getByRole('alert')).toHaveTextContent(/Missing authorization request/);
  });
});

describe('AgentAccess', () => {
  it('shows a not-enabled notice when the endpoint is disabled', async () => {
    server.use(
      http.get('/v1/users/me/agent-endpoint', () =>
        ok({
          enabled: false,
          default_grant_ttl_seconds: 3600,
          max_grant_ttl_seconds: 86400,
          refresh_tokens_enabled: true,
        })
      )
    );
    renderAt(<AgentAccess />, '/app/agent-access');
    expect(await screen.findByText(/not enabled on this server/)).toBeInTheDocument();
  });

  it('uses live grant limits in the create dialog', async () => {
    server.use(
      http.get('/v1/users/me/agent-endpoint', () =>
        ok({
          enabled: true,
          default_grant_ttl_seconds: 1800,
          max_grant_ttl_seconds: 7200,
          refresh_tokens_enabled: true,
        })
      ),
      http.get('/v1/users/me/agent-grants', () =>
        HttpResponse.json({ ok: true, data: [], pagination: { has_more: false } })
      ),
      http.get('/v1/users/me/clients', () =>
        ok([{ id: 'c1', clientName: 'Laptop', status: 'active' }])
      ),
      http.get('/v1/users/me/clients/c1/subscriptions', () => ok([]))
    );
    renderAt(<AgentAccess />, '/app/agent-access');
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: /Create one-shot grant/ }));
    expect(await screen.findByText(/default 30 minutes, maximum 2 hours/)).toBeInTheDocument();
  });
  const future = new Date(Date.now() + 3600_000).toISOString();
  const grant = {
    grant_id: 'g1',
    label: 'CI bot',
    client_id: null,
    client_name: null,
    bound_client_id: 'c1',
    bound_client_name: 'Laptop',
    scopes: ['mcp:github'],
    tool_allowlist: null,
    resource: 'https://h/mcp',
    created_at: new Date().toISOString(),
    expires_at: future,
    last_used_at: null,
    revoked_at: null,
    has_refresh_token: false,
  };

  it('lists grants and revokes one', async () => {
    let deleted = '';
    server.use(
      http.get('/v1/users/me/agent-grants', () =>
        HttpResponse.json({
          ok: true,
          data: [grant],
          pagination: { has_more: false, total_count: 1 },
        })
      ),
      http.delete('/v1/users/me/agent-grants/:id', ({ params }) => {
        deleted = String(params.id);
        return ok({ grant_id: 'g1', revoked_at: new Date().toISOString() });
      })
    );
    renderAt(<AgentAccess />, '/app/agent-access');
    expect(await screen.findByText('CI bot')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Client' })).toBeInTheDocument();
    expect(screen.getByText('Laptop')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Revoke CI bot' }));
    await user.click(await screen.findByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(deleted).toBe('g1'));
  });

  it('loads more grants via cursor', async () => {
    const cursors: (string | null)[] = [];
    server.use(
      http.get('/v1/users/me/agent-grants', ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        cursors.push(cursor);
        return cursor
          ? HttpResponse.json({
              ok: true,
              data: [{ ...grant, grant_id: 'g2', label: 'Second' }],
              pagination: { has_more: false, total_count: 2 },
            })
          : HttpResponse.json({
              ok: true,
              data: [grant],
              pagination: { has_more: true, total_count: 2, next_cursor: 'c1' },
            });
      })
    );
    renderAt(<AgentAccess />, '/app/agent-access');
    expect(await screen.findByText('CI bot')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Second')).toBeInTheDocument();
    expect(cursors).toEqual([null, 'c1']);
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('shows empty state', async () => {
    server.use(
      http.get('/v1/users/me/agent-grants', () =>
        HttpResponse.json({ ok: true, data: [], pagination: { has_more: false, total_count: 0 } })
      )
    );
    renderAt(<AgentAccess />, '/app/agent-access');
    expect(await screen.findByText('No agent access')).toBeInTheDocument();
  });

  it('creates a one-shot grant and shows the token', async () => {
    server.use(
      http.get('/v1/users/me/agent-grants', () =>
        HttpResponse.json({ ok: true, data: [], pagination: { has_more: false } })
      ),
      http.get('/v1/users/me/clients', () =>
        ok([
          { id: 'c1', clientName: 'Laptop', status: 'active' },
          { id: 'c9', clientName: 'Old', status: 'revoked' },
        ])
      ),
      http.get('/v1/users/me/clients/c1/subscriptions', () =>
        ok([{ id: 's1', clientId: 'c1', mcpName: 'github', status: 'active' }])
      ),
      http.post('/v1/users/me/agent-grants', async ({ request }) => {
        const b = (await request.json()) as {
          label: string;
          scopes: string[];
          bound_client_id: string;
        };
        expect(b.bound_client_id).toBe('c1');
        expect(b.scopes).toEqual(['mcp:github']);
        return ok({
          grant_id: 'g2',
          access_token: 'amb_at_secret',
          token_type: 'Bearer',
          expires_at: future,
          resource: 'https://h/mcp',
          scopes: b.scopes,
        });
      })
    );
    renderAt(<AgentAccess />, '/app/agent-access');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Create one-shot grant/ }));
    await user.type(await screen.findByRole('textbox', { name: 'Label' }), 'ci');
    await user.click(await screen.findByRole('checkbox', { name: 'github' }));
    await user.click(screen.getByRole('button', { name: 'Create grant' }));
    expect(await screen.findByTestId('grant-token')).toHaveTextContent('amb_at_secret');
  });
});

describe('AgentEndpoint (admin)', () => {
  it('toggles DCR and disables a client', async () => {
    let dcr: unknown;
    let patched: unknown;
    server.use(
      http.get('/v1/admin/agent-endpoint/settings', () =>
        ok({ enabled: true, dynamic_client_registration: false })
      ),
      http.put('/v1/admin/agent-endpoint/settings', async ({ request }) => {
        dcr = await request.json();
        return ok({ enabled: true, dynamic_client_registration: true });
      }),
      http.get('/v1/admin/oauth-clients', () =>
        HttpResponse.json({
          ok: true,
          data: [
            {
              client_id: 'cl1',
              client_name: 'Acme',
              redirect_uris: ['http://localhost/cb'],
              registered_via: 'dcr',
              created_at: new Date().toISOString(),
              last_used_at: null,
              disabled: false,
            },
          ],
          pagination: { has_more: false },
        })
      ),
      http.patch('/v1/admin/oauth-clients/cl1', async ({ request }) => {
        patched = await request.json();
        return ok({});
      })
    );
    renderAt(<AgentEndpoint />, '/app/admin/agent-endpoint');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('switch', { name: 'Dynamic client registration' }));
    await waitFor(() => expect(dcr).toEqual({ dynamic_client_registration: true }));
    expect(await screen.findByText('DCR (unverified)')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Disable' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(patched).toEqual({ disabled: true }));
  });
});
