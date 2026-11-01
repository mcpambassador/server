import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ExclamationTriangleIcon } from '@heroicons/react/20/solid';
import { Heading } from '@/components/catalyst/heading';
import { Text } from '@/components/catalyst/text';
import { Button } from '@/components/catalyst/button';
import { Badge } from '@/components/catalyst/badge';
import { Checkbox, CheckboxField, CheckboxGroup } from '@/components/catalyst/checkbox';
import { Field, Label, Description, FieldGroup } from '@/components/catalyst/fieldset';
import { Select } from '@/components/catalyst/select';
import { Input } from '@/components/catalyst/input';
import { Textarea } from '@/components/catalyst/textarea';
import { Logomark } from '@/components/brand/Logomark';
import { safeRedirectUrl } from '@/lib/return-to';
import { ApiError } from '@/api/client';
import { useConsentDetails, useSubmitConsent } from '@/api/hooks/use-agent';
import { parseToolAllowlist, ttlOptions, formatDuration } from '@/api/agent-types';
import { usePageTitle } from '@/hooks/usePageTitle';

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404)
      return 'This authorization request has expired or was already used. Return to the agent and start again.';
    if (err.status === 403)
      return 'This authorization request belongs to a different user. Sign in as the user who started it.';
    if (err.status === 400) return err.message || 'The selected scopes are not valid.';
    return err.message;
  }
  return 'An unexpected error occurred.';
}

export function OAuthConsent() {
  usePageTitle('Authorize agent');
  const [params] = useSearchParams();
  const requestId = params.get('request_id');
  const { data: details, isLoading, error } = useConsentDetails(requestId);
  const submit = useSubmitConsent(requestId ?? '');

  const [clientId, setClientId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [toolsText, setToolsText] = useState('');
  const [ttl, setTtl] = useState<number | null>(null);
  const [label, setLabel] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [redirecting, setRedirecting] = useState(false);

  // A grant binds to exactly one of the user's Ambassador clients; scopes come from that client.
  const clients = details?.clients ?? [];
  const boundClient = clients.find(c => c.client_id === clientId) ?? clients[0];
  const availableSubs = useMemo(() => boundClient?.subscriptions ?? [], [boundClient]);

  // Preselect requested scopes (least privilege: nothing is selected when none were requested).
  const initialSelected = useMemo(() => {
    if (!details) return new Set<string>();
    const requested = new Set(details.requested_scopes);
    const all = requested.has('mcp:*');
    return new Set(availableSubs.filter(s => all || requested.has(s.scope)).map(s => s.scope));
  }, [details, availableSubs]);

  const scopes = selected ?? initialSelected;
  const options = details ? ttlOptions(details.default_ttl_seconds, details.max_ttl_seconds) : [];
  const effectiveTtl = ttl ?? details?.default_ttl_seconds ?? 3600;

  const toggle = (scope: string, on: boolean) => {
    const next = new Set(scopes);
    if (on) next.add(scope);
    else next.delete(scope);
    setSelected(next);
  };

  const pickClient = (id: string) => {
    setClientId(id);
    setSelected(null); // scopes belong to the selected client
  };

  const decide = async (decision: 'approve' | 'deny') => {
    if (!details) return;
    setSubmitError(null);
    try {
      const res = await submit.mutateAsync({
        decision,
        bound_client_id: decision === 'approve' ? boundClient?.client_id : undefined,
        scopes: decision === 'approve' ? Array.from(scopes) : [],
        tool_allowlist: decision === 'approve' ? parseToolAllowlist(toolsText) : undefined,
        ttl_seconds: Math.min(Math.max(effectiveTtl, 60), details.max_ttl_seconds),
        label: decision === 'approve' && label.trim() ? label.trim() : undefined,
      });
      const target = safeRedirectUrl(res.redirect_url);
      if (!target) {
        setSubmitError(
          'The agent supplied a redirect address that is not allowed, so you were not sent back. Your choice was recorded; return to the agent manually.'
        );
        return;
      }
      setRedirecting(true);
      window.location.assign(target.toString());
    } catch (err) {
      setSubmitError(errorMessage(err));
    }
  };

  let body;
  if (!requestId) {
    body = (
      <Text role="alert">
        Missing authorization request. Start the connection again from your agent.
      </Text>
    );
  } else if (isLoading) {
    body = <div className="animate-pulse h-64 w-full rounded-lg bg-zinc-200 dark:bg-zinc-700" />;
  } else if (error || !details) {
    body = <Text role="alert">{errorMessage(error)}</Text>;
  } else {
    const redirectHost = details.redirect_uri_host;
    const noClients = clients.length === 0;
    const noSubs = availableSubs.length === 0;
    body = (
      <div className="space-y-6">
        <div>
          <Heading>Authorize agent access</Heading>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Text>
              <strong>{details.client_name}</strong> wants to use your MCP Ambassador tools.
            </Text>
            {details.client_verified ? (
              <Badge color="green">Verified client</Badge>
            ) : (
              <Badge color="amber">Unverified client</Badge>
            )}
          </div>
        </div>

        {redirectHost && (
          <Text>
            After you decide, you will be sent back to <strong>{redirectHost}</strong>.
          </Text>
        )}

        {!details.client_verified && (
          <div
            role="alert"
            className="flex gap-3 rounded-lg bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-200"
          >
            <ExclamationTriangleIcon className="size-5 shrink-0" />
            <p>
              This client registered itself automatically and has not been verified by an
              administrator. Only approve it if you started this connection and recognize the name
              above.
            </p>
          </div>
        )}

        {noClients ? (
          <div role="alert" className="space-y-2">
            <Text>
              You have no active Ambassador clients, so there is nothing to grant access to. Create
              a client first, then start the connection again from your agent.
            </Text>
            <Link
              to="/app/clients"
              className="text-sm font-medium text-blue-600 underline dark:text-blue-400"
            >
              Create a client
            </Link>
          </div>
        ) : (
          <FieldGroup>
            <Field>
              <Label>Ambassador client</Label>
              <Description>
                The agent acts as this client: it can only use what this client is subscribed to.
              </Description>
              <Select
                name="bound_client_id"
                value={boundClient?.client_id ?? ''}
                onChange={e => pickClient(e.target.value)}
              >
                {clients.map(c => (
                  <option key={c.client_id} value={c.client_id}>
                    {c.client_name}
                    {c.profile_name ? ` (${c.profile_name})` : ''}
                  </option>
                ))}
              </Select>
            </Field>

            <Field>
              <Label>Allowed MCPs</Label>
              <Description>Choose which of your subscriptions this agent may use.</Description>
              {noSubs ? (
                <Text className="mt-3">This client has no active subscriptions to grant.</Text>
              ) : (
                <CheckboxGroup className="mt-3">
                  {availableSubs.map(sub => (
                    <CheckboxField key={sub.scope}>
                      <Checkbox
                        name="scope"
                        value={sub.scope}
                        checked={scopes.has(sub.scope)}
                        onChange={on => toggle(sub.scope, on)}
                      />
                      <Label>{sub.name}</Label>
                      {sub.description && <Description>{sub.description}</Description>}
                    </CheckboxField>
                  ))}
                </CheckboxGroup>
              )}
            </Field>

            <Field>
              <Label>Tool allowlist (optional)</Label>
              <Description>
                Restrict the agent to specific tools, one fully qualified name per line. Leave empty
                to allow every tool in the selected MCPs.
              </Description>
              <Textarea
                name="tool_allowlist"
                rows={3}
                value={toolsText}
                onChange={e => setToolsText(e.target.value)}
                placeholder="github.search_code"
              />
            </Field>

            <Field>
              <Label>Access lasts</Label>
              <Description>
                Maximum {formatDuration(details.max_ttl_seconds)}. You can revoke access at any time
                under Agent access.
              </Description>
              <Select
                name="ttl"
                value={effectiveTtl}
                onChange={e => setTtl(Number(e.target.value))}
              >
                {options.map(o => (
                  <option key={o.seconds} value={o.seconds}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>

            <Field>
              <Label>Label (optional)</Label>
              <Input
                name="label"
                maxLength={128}
                value={label}
                onChange={e => setLabel(e.target.value)}
                placeholder={details.client_name}
              />
            </Field>
          </FieldGroup>
        )}

        {submitError && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {submitError}
          </p>
        )}

        <div className="flex justify-end gap-3">
          <Button
            color="zinc"
            onClick={() => decide('deny')}
            disabled={submit.isPending || redirecting}
          >
            Deny
          </Button>
          <Button
            color="green"
            onClick={() => decide('approve')}
            disabled={submit.isPending || redirecting || noClients || scopes.size === 0}
          >
            {submit.isPending || redirecting ? 'Working...' : 'Approve'}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl px-4 py-12">
      <div className="mb-8 flex justify-center">
        <Logomark className="h-10 w-10" />
      </div>
      <div className="rounded-lg bg-white p-6 ring-1 ring-zinc-950/10 dark:bg-white/5 dark:ring-white/10">
        {body}
      </div>
    </div>
  );
}
