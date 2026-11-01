import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { describe, it, expect } from 'vitest';
import { server } from '../mocks/server';
import { Registry } from '../../pages/admin/Registry';

const mcp = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  display_name: name,
  description: `${name} description`,
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
  ...over,
});

describe('Registry page: unavailable entries (TD-035)', () => {
  it('greys out entries the server cannot install, with the reason and Install disabled', async () => {
    server.use(
      http.get('/v1/admin/registry', () =>
        HttpResponse.json({
          ok: true,
          data: {
            registry: {
              name: 'r',
              updated_at: null,
              mcp_count: 2,
              last_fetched_at: null,
              url: 'https://r',
              enabled: true,
            },
            mcps: [
              mcp('plain'),
              mcp('github', {
                installable: false,
                unavailable_reason: 'requires a server-side OAuth client secret for this provider',
              }),
            ],
          },
        })
      )
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <Registry />
        </MemoryRouter>
      </QueryClientProvider>
    );
    expect(await screen.findByText('github description')).toBeInTheDocument();
    expect(
      screen.getByText(/Not installable on this server: requires a server-side OAuth client secret/)
    ).toBeInTheDocument();

    const cards = Array.from(container.querySelectorAll('[data-unavailable]'));
    expect(cards).toHaveLength(1);
    expect(cards[0]).toHaveTextContent('github');
    const installs = screen.getAllByRole('button', { name: 'Install' });
    expect(installs).toHaveLength(2);
    const disabled = installs.filter(b => b.hasAttribute('disabled'));
    expect(disabled).toHaveLength(1);
    expect(cards[0]).toContainElement(disabled[0] as HTMLElement);
  });
});
