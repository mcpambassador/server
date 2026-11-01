import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { describe, it, expect } from 'vitest';
import { server } from '../mocks/server';
import { Registry } from '../../pages/admin/Registry';
import { Marketplace } from '../../pages/Marketplace';
import { RegistryImportModal } from '../../components/admin/RegistryImportModal';

const ICON = 'https://evil.example/icon.png';

const registryMcp = {
  name: 'iconic',
  display_name: 'Iconic',
  description: 'iconic description',
  icon_url: ICON,
  transport_type: 'http',
  config: { url: 'https://mcp.example/mcp' },
  auth_type: 'none',
  isolation_mode: 'shared',
  requires_user_credentials: false,
  tags: [],
  category: 'Developer Tools',
  version: '1.0.0',
  maintainer: 'm',
  verified: false,
  installed: false,
  installable: true,
};

function useRegistryHandler() {
  server.use(
    http.get('/v1/admin/registry', () =>
      HttpResponse.json({
        ok: true,
        data: {
          registry: {
            name: 'r',
            updated_at: null,
            mcp_count: 1,
            last_fetched_at: null,
            url: 'https://r',
            enabled: true,
          },
          mcps: [registryMcp],
        },
      })
    )
  );
}

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

const noIconImg = (c: HTMLElement) => {
  expect(c.querySelectorAll('img')).toHaveLength(0);
  expect(c.innerHTML).not.toContain(ICON);
  expect(document.body.querySelectorAll('img')).toHaveLength(0);
};

describe('MCP icons are not rendered as <img>', () => {
  it('admin Registry page', async () => {
    useRegistryHandler();
    const { container } = wrap(<Registry />);
    expect(await screen.findByText('iconic description')).toBeInTheDocument();
    noIconImg(container);
  });

  it('RegistryImportModal', async () => {
    useRegistryHandler();
    const { container } = wrap(<RegistryImportModal open onClose={() => {}} onSelect={() => {}} />);
    expect(await screen.findByText(/iconic description/)).toBeInTheDocument();
    noIconImg(container);
  });

  it('Marketplace page', async () => {
    server.use(
      http.get('/v1/marketplace', () =>
        HttpResponse.json({
          ok: true,
          data: [
            {
              id: 'm1',
              name: 'iconic-mp',
              description: 'marketplace iconic',
              icon_url: ICON,
              category: 'Developer Tools',
              isolationMode: 'shared',
              requiresUserCredentials: false,
              subscribed: false,
              tools: [],
            },
          ],
          pagination: { has_more: false, next_cursor: null, total_count: 1 },
        })
      )
    );
    const { container } = wrap(<Marketplace />);
    await waitFor(() => expect(screen.getByText(/iconic-mp/i)).toBeInTheDocument());
    noIconImg(container);
  });
});
