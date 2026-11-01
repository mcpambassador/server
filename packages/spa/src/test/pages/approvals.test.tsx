/** ADR-023 (3c) SPA: approvals queue, decision dialog, step-up, badge, tool-policy controls. */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ADMIN_APPROVALS_ROUTE,
  ADMIN_APPROVALS_SUMMARY_ROUTE,
  ADMIN_APPROVAL_DECISION_ROUTE,
  ADMIN_APPROVAL_ROUTE,
  ADMIN_MCP_APPROVAL_DEFAULT_ROUTE,
  ADMIN_MCP_TOOL_POLICIES_ROUTE,
  ADMIN_MCP_TOOL_POLICY_ROUTE,
  AUTH_REAUTH_ROUTE,
  USER_APPROVALS_ROUTE,
  USER_APPROVALS_SUMMARY_ROUTE,
  USER_APPROVAL_DECISION_ROUTE,
  USER_APPROVAL_ROUTE,
} from '@mcpambassador/contracts';
import { server } from '../mocks/server';
import { Approvals } from '../../pages/Approvals';
import { ToolPolicyPanel } from '../../components/admin/ToolPolicyPanel';

const HASH = 'a'.repeat(64);
const NOW = '2026-11-01T12:00:00Z';
const LATER = '2026-11-01T12:15:00Z';

const summary = (over: Record<string, unknown> = {}) => ({
  approval_id: 'ap1',
  status: 'pending',
  mcp_id: 'm1',
  mcp_name: 'github',
  tool_name: 'delete_repo',
  grant_id: 'g1',
  grant_label: 'Claude cloud agent',
  bound_client_id: 'c1',
  user_id: 'u1',
  required_approver: 'owner',
  args_hash: HASH,
  created_at: NOW,
  expires_at: LATER,
  decided_at: null,
  decided_by: null,
  approver_role: null,
  self_approved: false,
  ...over,
});

const detail = (over: Record<string, unknown> = {}) => ({
  ...summary(),
  preview: '{"repo":"acme/app"}',
  definition_changed: false,
  read_only: false,
  decision_reason: null,
  void_reason: null,
  ...over,
});

const quietSidebar = http.get('/v1/users/me/agent-endpoint', () =>
  HttpResponse.json({ ok: true, data: {} })
);

const session = (isAdmin: boolean) =>
  http.get('/v1/auth/session', () =>
    HttpResponse.json({
      ok: true,
      data: { user: { id: 'u1', username: 'alice', isAdmin, createdAt: NOW } },
    })
  );

function renderAt(path: string, ui: React.ReactNode = <Approvals />) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/app/approvals" element={ui} />
          <Route path="/app/approvals/:approvalId" element={ui} />
          <Route path="*" element={ui} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

/** jsdom reports 0 for layout; make the preview look 1000px tall in a 100px box. */
function fakeScrollableBox() {
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(100);
}
function scrollTo(el: HTMLElement, top: number) {
  Object.defineProperty(el, 'scrollTop', { value: top, configurable: true });
  fireEvent.scroll(el);
}

async function openAndReadAll() {
  const user = userEvent.setup();
  await user.click(await screen.findByTestId('expand-preview'));
  scrollTo(await screen.findByTestId('approval-preview'), 900);
  return user;
}

type Post = { url: string; body: unknown };

function mockDecision(isAdmin: boolean, posts: Post[], respond?: () => Response) {
  server.use(
    http.post(
      isAdmin ? ADMIN_APPROVAL_DECISION_ROUTE : USER_APPROVAL_DECISION_ROUTE,
      async ({ request }) => {
        posts.push({ url: new URL(request.url).pathname, body: await request.json() });
        return respond
          ? respond()
          : HttpResponse.json({ ok: true, data: detail({ status: 'approved' }) });
      }
    ),
    http.post(AUTH_REAUTH_ROUTE, async ({ request }) => {
      posts.push({ url: new URL(request.url).pathname, body: await request.json() });
      return HttpResponse.json({
        ok: true,
        data: { reauthenticated_until: LATER, window_seconds: 300 },
      });
    })
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** The theme store reads matchMedia when first imported, so stub it before loading the sidebar. */
async function loadSidebar() {
  if (!window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    });
  }
  return (await import('../../components/layout/AppSidebar')).AppSidebar;
}

describe('approvals queue', () => {
  it('admin sees everything via the admin routes; rows carry no preview', async () => {
    const urls: string[] = [];
    server.use(
      session(true),
      http.get(ADMIN_APPROVALS_ROUTE, ({ request }) => {
        urls.push(request.url);
        return HttpResponse.json({
          ok: true,
          data: {
            items: [
              { ...summary(), preview: 'TOP-SECRET-PREVIEW' },
              summary({ approval_id: 'ap2', grant_label: 'Other user agent', user_id: 'u2' }),
            ],
            next_cursor: null,
          },
        });
      }),
      http.get(USER_APPROVALS_ROUTE, () => {
        throw new Error('admin must not use the user route');
      })
    );
    renderAt('/app/approvals');
    const list = await screen.findByTestId('approval-list');
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(2));
    expect(within(list).getByText(/Other user agent/)).toBeInTheDocument();
    expect(screen.queryByText(/TOP-SECRET-PREVIEW/)).not.toBeInTheDocument();
    expect(new URL(urls[0]!).searchParams.get('status')).toBe('pending');
  });

  it('a non-admin user only uses their own routes', async () => {
    const calls: string[] = [];
    server.use(
      session(false),
      http.get(USER_APPROVALS_ROUTE, ({ request }) => {
        calls.push(new URL(request.url).pathname);
        return HttpResponse.json({ ok: true, data: { items: [summary()], next_cursor: null } });
      }),
      http.get(ADMIN_APPROVALS_ROUTE, () => {
        throw new Error('user must not use the admin route');
      })
    );
    renderAt('/app/approvals');
    expect(await screen.findByText(/delete_repo/)).toBeInTheDocument();
    expect(calls).toEqual([USER_APPROVALS_ROUTE]);
  });

  it('shows an empty state and the History tab drops pending rows', async () => {
    server.use(
      session(true),
      http.get(ADMIN_APPROVALS_ROUTE, ({ request }) => {
        const status = new URL(request.url).searchParams.get('status');
        return HttpResponse.json({
          ok: true,
          data: {
            items: status
              ? []
              : [summary({ approval_id: 'p' }), summary({ approval_id: 'd', status: 'denied' })],
            next_cursor: null,
          },
        });
      })
    );
    const user = userEvent.setup();
    renderAt('/app/approvals');
    expect(await screen.findByText('Nothing waiting')).toBeInTheDocument();
    await user.click(screen.getByTestId('tab-history'));
    const list = await screen.findByTestId('approval-list');
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(1));
    expect(within(list).getByText('denied')).toBeInTheDocument();
  });
});

describe('decision dialog', () => {
  function adminDetail(d: Record<string, unknown>, fetches: string[] = []) {
    server.use(
      session(true),
      http.get(ADMIN_APPROVALS_ROUTE, () =>
        HttpResponse.json({ ok: true, data: { items: [summary()], next_cursor: null } })
      ),
      http.get(ADMIN_APPROVAL_ROUTE, ({ request }) => {
        fetches.push(new URL(request.url).pathname);
        return HttpResponse.json({ ok: true, data: d });
      })
    );
  }

  it('Approve stays disabled until the preview is expanded and scrolled to the end', async () => {
    fakeScrollableBox();
    adminDetail(detail());
    const posts: Post[] = [];
    mockDecision(true, posts);
    renderAt('/app/approvals/ap1');
    const user = userEvent.setup();
    const approve = await screen.findByTestId('approve-btn');
    expect(approve).toBeDisabled();
    expect(screen.getByTestId('read-warning')).toBeInTheDocument();

    await user.click(screen.getByTestId('expand-preview'));
    const pre = await screen.findByTestId('approval-preview');
    expect(screen.getByTestId('approve-btn')).toBeDisabled(); // expanded but not read
    scrollTo(pre, 200);
    expect(screen.getByTestId('approve-btn')).toBeDisabled(); // mid-way
    scrollTo(pre, 900);
    await waitFor(() => expect(screen.getByTestId('approve-btn')).toBeEnabled());

    await user.click(screen.getByTestId('approve-btn'));
    await waitFor(() => expect(posts).toHaveLength(1));
    // The approver approves exactly the hash they were shown; no password, no reauth call.
    expect(posts[0]!.body).toEqual({ decision: 'approve', expected_args_hash: HASH });
    expect(posts[0]!.url).toBe('/v1/admin/approvals/ap1/decision');
  });

  it('shows invisible characters as ⟨U+XXXX⟩ and never renders markup', async () => {
    const evil = 'a​b‮c <img src=x onerror="alert(1)"><script>boom()</script>';
    adminDetail(detail({ preview: evil }));
    renderAt('/app/approvals/ap1');
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('expand-preview'));
    const pre = await screen.findByTestId('approval-preview');
    expect(pre.textContent).toContain('⟨U+200B⟩');
    expect(pre.textContent).toContain('⟨U+202E⟩');
    expect(pre.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(pre.querySelector('img, script')).toBeNull();
    expect(pre.textContent).not.toContain('​');
  });

  it('makes redaction markers visible', async () => {
    adminDetail(detail({ preview: '{"token":"[REDACTED]","note":"hi [REDACTED:email]"}' }));
    renderAt('/app/approvals/ap1');
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('expand-preview'));
    const marks = await screen.findAllByTestId('redaction-marker');
    // Only the server's exact token is highlighted; look-alike text an agent typed is not.
    expect(marks.map(m => m.textContent)).toEqual(['[REDACTED]']);
  });

  it('shows the agent label and the hash prefix', async () => {
    adminDetail(detail());
    renderAt('/app/approvals/ap1');
    expect((await screen.findByTestId('approval-agent')).textContent).toBe('Claude cloud agent');
    expect(screen.getByTestId('approval-hash').textContent).toBe(HASH.slice(0, 12));
  });

  it('a changed tool definition shows a banner and blocks Approve, but Deny still works', async () => {
    fakeScrollableBox();
    adminDetail(detail({ definition_changed: true }));
    const posts: Post[] = [];
    mockDecision(true, posts);
    renderAt('/app/approvals/ap1');
    expect(await screen.findByTestId('definition-changed')).toBeInTheDocument();
    await openAndReadAll();
    expect(screen.getByTestId('approve-btn')).toBeDisabled();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('deny-btn'));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toMatchObject({ decision: 'deny', expected_args_hash: HASH });
  });

  it('a missing preview can never be approved', async () => {
    adminDetail(detail({ preview: null }));
    renderAt('/app/approvals/ap1');
    expect(await screen.findByTestId('preview-none')).toBeInTheDocument();
    expect(screen.getByTestId('approve-btn')).toBeDisabled();
  });

  it('Deny works without reading the preview and carries the reason', async () => {
    adminDetail(detail());
    const posts: Post[] = [];
    mockDecision(true, posts);
    renderAt('/app/approvals/ap1');
    const user = userEvent.setup();
    await user.type(await screen.findByTestId('decision-reason'), '  looks wrong  ');
    await user.click(screen.getByTestId('deny-btn'));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toEqual({
      decision: 'deny',
      expected_args_hash: HASH,
      reason: 'looks wrong',
    });
  });

  it('the owner of an admin-only request sees it read-only, with no decision buttons', async () => {
    server.use(
      session(false),
      http.get(USER_APPROVALS_ROUTE, () =>
        HttpResponse.json({
          ok: true,
          data: { items: [summary({ required_approver: 'admin' })], next_cursor: null },
        })
      ),
      http.get(USER_APPROVAL_ROUTE, () =>
        HttpResponse.json({
          ok: true,
          data: detail({ required_approver: 'admin', read_only: true }),
        })
      )
    );
    renderAt('/app/approvals/ap1');
    expect(await screen.findByTestId('read-only-note')).toBeInTheDocument();
    expect(screen.queryByTestId('approve-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('deny-btn')).not.toBeInTheDocument();
  });

  it('a decided request is closed: no buttons, no preview', async () => {
    adminDetail(detail({ status: 'voided', preview: null, void_reason: 'grant_revoked' }));
    renderAt('/app/approvals/ap1');
    expect((await screen.findByTestId('closed-note')).textContent).toMatch(/voided.*grant revoked/);
    expect(screen.queryByTestId('approve-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('expand-preview')).not.toBeInTheDocument();
  });

  it('a deep link loads fresh server data every time', async () => {
    const fetches: string[] = [];
    adminDetail(detail(), fetches);
    const first = renderAt('/app/approvals/ap1');
    await screen.findByTestId('approval-agent');
    first.unmount();
    renderAt('/app/approvals/ap1');
    await screen.findByTestId('approval-agent');
    expect(fetches).toHaveLength(2);
  });

  it.each([403, 404])('a deep link answered with %i shows no request data', async status => {
    server.use(
      session(false),
      http.get(USER_APPROVALS_ROUTE, () =>
        HttpResponse.json({ ok: true, data: { items: [], next_cursor: null } })
      ),
      http.get(USER_APPROVAL_ROUTE, () =>
        HttpResponse.json(
          { ok: false, error: { code: status === 403 ? 'FORBIDDEN' : 'NOT_FOUND', message: 'no' } },
          { status }
        )
      )
    );
    renderAt('/app/approvals/other-users-request');
    expect(await screen.findByTestId('approval-load-error')).toBeInTheDocument();
    expect(screen.queryByTestId('approval-agent')).not.toBeInTheDocument();
    expect(screen.queryByTestId('approve-btn')).not.toBeInTheDocument();
  });
  it('an admin decides their own owner-class request through the owner route (read-only on the admin route)', async () => {
    fakeScrollableBox();
    server.use(
      session(true),
      http.get(ADMIN_APPROVALS_ROUTE, () =>
        HttpResponse.json({ ok: true, data: { items: [], next_cursor: null } })
      ),
      http.get(ADMIN_APPROVAL_ROUTE, () =>
        HttpResponse.json({ ok: true, data: detail({ read_only: true, user_id: 'u1' }) })
      )
    );
    const posts: Post[] = [];
    mockDecision(false, posts);
    renderAt('/app/approvals/ap1');
    const user = await openAndReadAll();
    expect(screen.queryByTestId('reauth-password')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('approve-btn')).toBeEnabled());
    await user.click(screen.getByTestId('approve-btn'));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      url: '/v1/users/me/approvals/ap1/decision',
      body: { decision: 'approve', expected_args_hash: HASH },
    });
  });

  it("an admin still cannot decide another user's owner-class request", async () => {
    server.use(
      session(true),
      http.get(ADMIN_APPROVALS_ROUTE, () =>
        HttpResponse.json({ ok: true, data: { items: [], next_cursor: null } })
      ),
      http.get(ADMIN_APPROVAL_ROUTE, () =>
        HttpResponse.json({ ok: true, data: detail({ read_only: true, user_id: 'u2' }) })
      )
    );
    renderAt('/app/approvals/ap1');
    await screen.findByTestId('approval-agent');
    expect(screen.queryByTestId('approve-btn')).not.toBeInTheDocument();
  });
});

describe('step-up reauth', () => {
  it('admin-only requests need a password: reauth is called first, the password never reaches the decision', async () => {
    fakeScrollableBox();
    server.use(
      session(true),
      http.get(ADMIN_APPROVALS_ROUTE, () =>
        HttpResponse.json({ ok: true, data: { items: [], next_cursor: null } })
      ),
      http.get(ADMIN_APPROVAL_ROUTE, () =>
        HttpResponse.json({ ok: true, data: detail({ required_approver: 'admin' }) })
      )
    );
    const posts: Post[] = [];
    mockDecision(true, posts);
    renderAt('/app/approvals/ap1');
    const user = await openAndReadAll();
    expect(screen.getByTestId('approve-btn')).toBeDisabled(); // read, but no password yet
    await user.type(screen.getByTestId('reauth-password'), 'hunter2-hunter2');
    await waitFor(() => expect(screen.getByTestId('approve-btn')).toBeEnabled());
    await user.click(screen.getByTestId('approve-btn'));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[0]).toEqual({ url: AUTH_REAUTH_ROUTE, body: { password: 'hunter2-hunter2' } });
    expect(posts[1]!.body).toEqual({ decision: 'approve', expected_args_hash: HASH });
    expect(JSON.stringify(posts[1])).not.toContain('hunter2');
  });

  it('a 428 reauth_required answer reveals the password field and the retry succeeds', async () => {
    fakeScrollableBox();
    server.use(
      session(true),
      http.get(ADMIN_APPROVALS_ROUTE, () =>
        HttpResponse.json({ ok: true, data: { items: [], next_cursor: null } })
      ),
      http.get(ADMIN_APPROVAL_ROUTE, () => HttpResponse.json({ ok: true, data: detail() }))
    );
    const posts: Post[] = [];
    // Like the real server: 428 reauth_required until a reauth has been recorded.
    mockDecision(true, posts, () =>
      posts.some(p => p.url === AUTH_REAUTH_ROUTE)
        ? HttpResponse.json({ ok: true, data: detail({ status: 'approved' }) })
        : HttpResponse.json(
            { ok: false, error: { code: 'reauth_required', message: 'confirm password' } },
            { status: 428 }
          )
    );
    renderAt('/app/approvals/ap1');
    const user = await openAndReadAll();
    expect(screen.queryByTestId('reauth-password')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('approve-btn'));
    const pw = await screen.findByTestId('reauth-password');
    expect(screen.getByTestId('approve-btn')).toBeDisabled();
    await user.type(pw, 'pass-pass-pass');
    await user.click(screen.getByTestId('approve-btn'));
    const decision = '/v1/admin/approvals/ap1/decision';
    await waitFor(() => expect(posts.some(p => p.url === AUTH_REAUTH_ROUTE)).toBe(true));
    await waitFor(() => expect(posts.at(-1)?.url).toBe(decision));
    const urls = posts.map(p => p.url);
    expect(urls).toEqual([decision, AUTH_REAUTH_ROUTE, decision]); // refused (428), reauth, retry once
    expect(posts.at(-1)!.body).toEqual({ decision: 'approve', expected_args_hash: HASH });
  });
});

describe('approvals badge', () => {
  it.each([
    ['admin', true, ADMIN_APPROVALS_SUMMARY_ROUTE, USER_APPROVALS_SUMMARY_ROUTE],
    ['user', false, USER_APPROVALS_SUMMARY_ROUTE, ADMIN_APPROVALS_SUMMARY_ROUTE],
  ])('%s sees the pending count from their own summary route', async (_n, isAdmin, ok, other) => {
    server.use(
      quietSidebar,
      session(isAdmin),
      http.get(ok, () => HttpResponse.json({ ok: true, data: { pending_count: 3 } })),
      http.get(other, () => {
        throw new Error('wrong summary route');
      })
    );
    const AppSidebar = await loadSidebar();
    renderAt('/app/dashboard', <AppSidebar />);
    expect((await screen.findByTestId('approvals-badge')).textContent).toBe('3');
  });

  it('no badge when nothing is pending', async () => {
    server.use(
      quietSidebar,
      session(false),
      http.get(USER_APPROVALS_SUMMARY_ROUTE, () =>
        HttpResponse.json({ ok: true, data: { pending_count: 0 } })
      )
    );
    const AppSidebar = await loadSidebar();
    renderAt('/app/dashboard', <AppSidebar />);
    await screen.findByText('Approvals');
    await waitFor(() => expect(screen.queryByTestId('approvals-badge')).not.toBeInTheDocument());
  });
});

describe('tool policy panel (admin)', () => {
  const policy = (over: Record<string, unknown> = {}) => ({
    mcp_id: 'm1',
    tool_name: 'delete_repo',
    requires_approval: true,
    approver: 'owner',
    updated_by: 'admin',
    updated_at: NOW,
    ...over,
  });

  function setup(policies: unknown[] = []) {
    const puts: Array<{ url: string; body: unknown }> = [];
    server.use(
      http.get(ADMIN_MCP_TOOL_POLICIES_ROUTE, () =>
        HttpResponse.json({ ok: true, data: { policies } })
      ),
      http.put(ADMIN_MCP_TOOL_POLICY_ROUTE, async ({ request }) => {
        puts.push({ url: new URL(request.url).pathname, body: await request.json() });
        return HttpResponse.json({ ok: true, data: policy() });
      }),
      http.patch(ADMIN_MCP_APPROVAL_DEFAULT_ROUTE, async ({ request }) => {
        puts.push({ url: new URL(request.url).pathname, body: await request.json() });
        return HttpResponse.json({ ok: true, data: {} });
      })
    );
    renderAt('/x', <ToolPolicyPanel mcpId="m1" toolNames={['delete_repo', 'list_repos']} />);
    return puts;
  }

  it('turning a gate on forces an explicit approver choice (no default)', async () => {
    const puts = setup();
    const user = userEvent.setup();
    const row = await screen.findByTestId('policy-row-delete_repo');
    await user.click(within(row).getByRole('button', { name: 'Require approval' }));
    const select = within(row).getByLabelText(/who approves delete_repo/i) as HTMLSelectElement;
    expect(select.value).toBe('');
    const confirm = within(row).getByRole('button', { name: 'Require approval' });
    expect(confirm).toBeDisabled();
    await user.selectOptions(select, 'admin');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({
      url: '/v1/admin/mcps/m1/tool-policies/delete_repo',
      body: { requires_approval: true, approver: 'admin' },
    });
  });

  it('removing a gate sends requires_approval:false with no approver', async () => {
    const puts = setup([policy({ approver: 'admin' })]);
    const user = userEvent.setup();
    const row = await screen.findByTestId('policy-row-delete_repo');
    expect(await within(row).findByText('needs admin')).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Remove approval' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.body).toEqual({ requires_approval: false });
  });

  it('the MCP default also needs an explicit approver', async () => {
    const puts = setup();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Require approval for new tools' }));
    const confirm = screen.getByRole('button', { name: 'Require for new tools' });
    expect(confirm).toBeDisabled();
    await user.selectOptions(screen.getByLabelText(/who approves new tools/i), 'owner');
    await user.click(confirm);
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({
      url: '/v1/admin/mcps/m1/approval-default',
      body: { default_requires_approval: true, default_approver: 'owner' },
    });
  });
});
