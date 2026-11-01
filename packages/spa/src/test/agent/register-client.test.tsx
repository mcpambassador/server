import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { describe, it, expect, vi } from 'vitest';
import { isAllowedRedirectUri as contractCheck } from '@mcpambassador/contracts';
import { server } from '../mocks/server';
import { AgentEndpoint } from '../../pages/admin/AgentEndpoint';
import {
  isAllowedRedirectUri,
  claudeCodeCallbackPort,
  claudeCodeCommand,
} from '../../lib/redirect-uri';

const ok = (data: unknown) => HttpResponse.json({ ok: true, data });
const summary = (over: Record<string, unknown> = {}) => ({
  client_id: 'cl-new',
  client_name: 'Claude Code',
  redirect_uris: ['http://localhost:33418/callback'],
  registered_via: 'admin',
  created_at: '2026-11-01T00:00:00Z',
  last_used_at: null,
  disabled: false,
  ...over,
});

function setup(list: unknown[] = []) {
  server.use(
    http.get('/v1/admin/agent-endpoint/settings', () =>
      ok({ enabled: true, dynamic_client_registration: false })
    ),
    http.get('/v1/admin/oauth-clients', () =>
      HttpResponse.json({ ok: true, data: list, pagination: { has_more: false } })
    )
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AgentEndpoint />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('redirect URI validation', () => {
  const corpus = [
    'https://example.com/cb',
    'https://example.com:8443/cb?x=1',
    'http://localhost:33418/callback',
    'http://127.0.0.1:7777/cb',
    'http://[::1]:7777/cb',
    'http://localhost/cb',
    'http://example.com/cb',
    'http://localhost.evil.com/cb',
    'https://example.com/cb#frag',
    'https://example.com/cb#',
    'https://user:pw@example.com/cb',
    'http://user@localhost/cb',
    'javascript:alert(1)',
    'data:text/html,x',
    'file:///etc/passwd',
    'myapp://cb',
    'not a url',
    '',
    'https://example.com/' + 'a'.repeat(2100),
  ];
  it('agrees with the contracts check on every sample', () => {
    for (const v of corpus)
      expect([v.slice(0, 40), isAllowedRedirectUri(v)]).toEqual([
        v.slice(0, 40),
        contractCheck(v) && v.length <= 2048,
      ]);
  });
  it('only treats exactly http://localhost:<port>/callback as a Claude Code callback', () => {
    expect(claudeCodeCallbackPort('http://localhost:33418/callback')).toBe('33418');
    expect(claudeCodeCallbackPort('http://localhost:33418/callback2')).toBeNull();
    expect(claudeCodeCallbackPort('http://127.0.0.1:33418/callback')).toBeNull();
    expect(claudeCodeCallbackPort('https://localhost:33418/callback')).toBeNull();
    expect(claudeCodeCallbackPort('http://localhost:99999/callback')).toBeNull();
    expect(claudeCodeCommand('33418', 'amb.example')).toBe(
      'claude mcp add --transport http --callback-port 33418 ambassador https://amb.example:8443/mcp'
    );
  });
});

describe('Register client', () => {
  it('blocks invalid redirect URIs client-side and sends nothing', async () => {
    const posts: unknown[] = [];
    server.use(
      http.post('/v1/admin/oauth-clients', async ({ request }) => {
        posts.push(await request.json());
        return ok(summary());
      })
    );
    setup();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Register client' }));
    const dlg = await screen.findByRole('dialog');
    await user.type(within(dlg).getByLabelText('Client name'), 'Bad');
    await user.type(within(dlg).getByLabelText('Redirect URIs'), 'http://example.com/cb');
    await user.click(within(dlg).getByRole('button', { name: 'Register' }));
    expect(await within(dlg).findByText(/Not allowed: http:\/\/example.com\/cb/)).toBeVisible();
    expect(posts).toHaveLength(0);
  });

  it('requires a name and at least one URI', async () => {
    setup();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Register client' }));
    const dlg = await screen.findByRole('dialog');
    await user.click(within(dlg).getByRole('button', { name: 'Register' }));
    expect(await within(dlg).findByText('Enter a name.')).toBeVisible();
    expect(within(dlg).getByText('Enter at least one redirect URI.')).toBeVisible();
  });

  it('registers, shows the client_id and a Claude Code command, and copies them', async () => {
    const posts: unknown[] = [];
    server.use(
      http.post('/v1/admin/oauth-clients', async ({ request }) => {
        posts.push(await request.json());
        return HttpResponse.json({ ok: true, data: summary() }, { status: 201 });
      })
    );
    setup();
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    await user.click(await screen.findByRole('button', { name: 'Register client' }));
    const dlg = await screen.findByRole('dialog');
    await user.type(within(dlg).getByLabelText('Client name'), ' Claude Code ');
    await user.type(
      within(dlg).getByLabelText('Redirect URIs'),
      'http://localhost:33418/callback{Enter}http://localhost:33418/callback{Enter}'
    );
    await user.click(within(dlg).getByRole('button', { name: 'Register' }));

    expect(await within(dlg).findByText('cl-new')).toBeVisible();
    expect(posts).toEqual([
      { client_name: 'Claude Code', redirect_uris: ['http://localhost:33418/callback'] },
    ]);
    const cmd = `claude mcp add --transport http --callback-port 33418 ambassador https://${window.location.hostname}:8443/mcp`;
    expect(within(dlg).getByText(cmd)).toBeVisible();
    await user.click(within(dlg).getByRole('button', { name: 'Copy client ID' }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('cl-new'));
    await user.click(within(dlg).getByRole('button', { name: 'Copy command' }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(cmd));
  });

  it('omits the Claude Code command for non-localhost redirects', async () => {
    server.use(
      http.post('/v1/admin/oauth-clients', () =>
        HttpResponse.json(
          { ok: true, data: summary({ redirect_uris: ['https://agent.example/cb'] }) },
          { status: 201 }
        )
      )
    );
    setup();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Register client' }));
    const dlg = await screen.findByRole('dialog');
    await user.type(within(dlg).getByLabelText('Client name'), 'Web agent');
    await user.type(within(dlg).getByLabelText('Redirect URIs'), 'https://agent.example/cb');
    await user.click(within(dlg).getByRole('button', { name: 'Register' }));
    expect(await within(dlg).findByText('cl-new')).toBeVisible();
    expect(within(dlg).queryByText(/claude mcp add/)).toBeNull();
  });

  it('deletes a client after confirmation', async () => {
    let deleted = '';
    server.use(
      http.delete('/v1/admin/oauth-clients/:id', ({ params }) => {
        deleted = String(params.id);
        return new HttpResponse(null, { status: 204 });
      })
    );
    setup([summary({ client_id: 'cl-old', client_name: 'Old agent' })]);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    const dlg = await screen.findByRole('dialog');
    expect(dlg).toHaveTextContent(/active grants revoked/);
    await user.click(within(dlg).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleted).toBe('cl-old'));
  });
});
