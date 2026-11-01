import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { describe, it, expect, vi } from 'vitest';
import { server } from '../mocks/server';
import { OAuthConsent } from '../../pages/OAuthConsent';
import { AgentAccess } from '../../pages/AgentAccess';
import { DISCLOSURE_MODE_OPTIONS, disclosureModeLabel } from '../../api/agent-types';

function renderAt(ui: React.ReactElement, route: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}
const ok = (data: unknown) => HttpResponse.json({ ok: true, data });
const HELP = /Progressive: the agent sees 3 tools \(search, describe, call\)/;

describe('disclosure mode (ADR-022)', () => {
  it('offers Full and Progressive, labelled', () => {
    expect(DISCLOSURE_MODE_OPTIONS.map(o => o.value)).toEqual(['full', 'progressive']);
    expect(disclosureModeLabel('progressive')).toBe('Progressive');
  });

  it('consent defaults to full and posts the chosen mode', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    server.use(
      http.get('/v1/oauth/consent/r1', () =>
        ok({
          client_name: 'Acme',
          client_verified: true,
          requested_scopes: ['mcp:github'],
          clients: [
            {
              client_id: 'c1',
              client_name: 'Laptop',
              profile_name: null,
              subscriptions: [{ name: 'github', scope: 'mcp:github' }],
            },
          ],
          default_ttl_seconds: 3600,
          max_ttl_seconds: 86400,
        })
      ),
      http.post('/v1/oauth/consent/r1', async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        return ok({ redirect_url: 'http://localhost:9/cb?code=c' });
      })
    );
    vi.stubGlobal('location', { ...window.location, assign: vi.fn() });
    renderAt(<OAuthConsent />, '/app/oauth/consent?request_id=r1');
    const select = await screen.findByRole('combobox', { name: /Tool list/ });
    expect(select).toHaveValue('full');
    expect(screen.getByText(HELP)).toBeInTheDocument();

    const user = userEvent.setup();
    await user.selectOptions(select, 'progressive');
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ decision: 'approve', disclosure_mode: 'progressive' });
    vi.unstubAllGlobals();
  });

  it('deny does not send a mode', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    server.use(
      http.get('/v1/oauth/consent/r2', () =>
        ok({
          client_name: 'Acme',
          client_verified: true,
          requested_scopes: [],
          clients: [{ client_id: 'c1', client_name: 'L', profile_name: null, subscriptions: [] }],
          default_ttl_seconds: 3600,
          max_ttl_seconds: 86400,
        })
      ),
      http.post('/v1/oauth/consent/r2', async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        return ok({ redirect_url: 'http://localhost:9/cb?error=access_denied' });
      })
    );
    vi.stubGlobal('location', { ...window.location, assign: vi.fn() });
    renderAt(<OAuthConsent />, '/app/oauth/consent?request_id=r2');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]?.decision).toBe('deny');
    expect('disclosure_mode' in (bodies[0] ?? {})).toBe(false);
    vi.unstubAllGlobals();
  });

  const future = new Date(Date.now() + 3600_000).toISOString();
  const grant = (id: string, label: string, mode: 'full' | 'progressive') => ({
    grant_id: id,
    label,
    client_id: null,
    client_name: null,
    bound_client_id: 'c1',
    bound_client_name: 'Laptop',
    scopes: ['mcp:github'],
    tool_allowlist: null,
    disclosure_mode: mode,
    resource: 'https://h/mcp',
    created_at: new Date().toISOString(),
    expires_at: future,
    last_used_at: null,
    revoked_at: null,
    has_refresh_token: false,
  });
  const endpoint = http.get('/v1/users/me/agent-endpoint', () =>
    ok({
      enabled: true,
      default_grant_ttl_seconds: 3600,
      max_grant_ttl_seconds: 86400,
      refresh_tokens_enabled: true,
      resource_url: 'https://amb.test:8443/mcp',
    })
  );

  it('grants list shows each grant’s mode', async () => {
    server.use(
      endpoint,
      http.get('/v1/users/me/agent-grants', () =>
        HttpResponse.json({
          ok: true,
          data: [grant('g1', 'Full bot', 'full'), grant('g2', 'Lean bot', 'progressive')],
          pagination: { has_more: false, total_count: 2 },
        })
      )
    );
    renderAt(<AgentAccess />, '/app/agent-access');
    await screen.findByText('Lean bot');
    expect(screen.getAllByText('Tool list: Full')).toHaveLength(1);
    expect(screen.getAllByText('Tool list: Progressive')).toHaveLength(1);
  });

  it('one-shot dialog defaults to full and sends the chosen mode', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    server.use(
      endpoint,
      http.get('/v1/users/me/agent-grants', () =>
        HttpResponse.json({ ok: true, data: [], pagination: { has_more: false } })
      ),
      http.get('/v1/users/me/clients', () =>
        ok([{ id: 'c1', clientName: 'Laptop', status: 'active' }])
      ),
      http.get('/v1/users/me/clients/c1/subscriptions', () =>
        ok([{ id: 's1', clientId: 'c1', mcpName: 'github', status: 'active' }])
      ),
      http.post('/v1/users/me/agent-grants', async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        return ok({
          grant_id: 'g9',
          access_token: 'amb_at_secret',
          token_type: 'Bearer',
          expires_at: future,
          resource: 'https://h/mcp',
          scopes: ['mcp:github'],
        });
      })
    );
    renderAt(<AgentAccess />, '/app/agent-access');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Create one-shot grant/ }));
    const select = await screen.findByRole('combobox', { name: /Tool list/ });
    expect(select).toHaveValue('full');
    expect(screen.getByText(HELP)).toBeInTheDocument();
    await user.selectOptions(select, 'progressive');
    await user.click(await screen.findByRole('checkbox', { name: 'github' }));
    await user.click(screen.getByRole('button', { name: 'Create grant' }));
    await screen.findByTestId('grant-token');
    expect(bodies[0]).toMatchObject({ disclosure_mode: 'progressive' });
  });
});
