import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/catalyst/button';
import { Input } from '@/components/catalyst/input';
import { Textarea } from '@/components/catalyst/textarea';
import { Field, Label, Description, ErrorMessage } from '@/components/catalyst/fieldset';
import {
  Dialog,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogActions,
} from '@/components/catalyst/dialog';
import { useCreateOAuthClient } from '@/api/hooks/use-agent';
import type { OAuthClientSummary } from '@/api/agent-types';
import {
  parseRedirectUris,
  validateRedirectUris,
  claudeCodeCallbackPort,
  claudeCodeCommand,
} from '@/lib/redirect-uri';

async function copyText(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  } catch {
    toast.error('Copy failed — select the text and copy it manually');
  }
}

export function RegisterClientDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateOAuthClient();
  const [name, setName] = useState('');
  const [uriText, setUriText] = useState('');
  const [touched, setTouched] = useState(false);
  const [created, setCreated] = useState<OAuthClientSummary | null>(null);

  const uris = parseRedirectUris(uriText);
  const uriError = validateRedirectUris(uris);
  const nameError = name.trim()
    ? name.trim().length > 128
      ? 'At most 128 characters.'
      : null
    : 'Enter a name.';

  const close = () => {
    setName('');
    setUriText('');
    setTouched(false);
    setCreated(null);
    create.reset();
    onClose();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (nameError || uriError) return;
    try {
      setCreated(await create.mutateAsync({ client_name: name.trim(), redirect_uris: uris }));
    } catch (err) {
      toast.error('Failed to register client', { description: (err as Error)?.message });
    }
  };

  const ports = created
    ? created.redirect_uris.map(claudeCodeCallbackPort).filter((p): p is string => !!p)
    : [];

  return (
    <Dialog open={open} onClose={close}>
      <DialogBody>
        {created ? (
          <>
            <DialogTitle>Client registered</DialogTitle>
            <DialogDescription>
              Give this client ID to the agent. It is not a secret (public client, PKCE).
            </DialogDescription>
            <div className="mt-4 space-y-4">
              <div>
                <p className="text-sm/6 font-medium text-zinc-900 dark:text-white">Client ID</p>
                <div className="mt-1 flex items-center gap-2">
                  <code className="break-all rounded bg-zinc-100 px-2 py-1 text-sm dark:bg-white/10">
                    {created.client_id}
                  </code>
                  <Button plain onClick={() => copyText(created.client_id, 'Client ID')}>
                    Copy client ID
                  </Button>
                </div>
              </div>
              {ports.map(port => {
                const cmd = claudeCodeCommand(port, window.location.hostname);
                return (
                  <div key={port}>
                    <p className="text-sm/6 font-medium text-zinc-900 dark:text-white">
                      Claude Code command (callback port {port})
                    </p>
                    <div className="mt-1 flex items-start gap-2">
                      <code className="break-all rounded bg-zinc-100 px-2 py-1 text-sm dark:bg-white/10">
                        {cmd}
                      </code>
                      <Button plain onClick={() => copyText(cmd, 'Command')}>
                        Copy command
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
            <DialogActions>
              <Button onClick={close}>Done</Button>
            </DialogActions>
          </>
        ) : (
          <form onSubmit={submit} noValidate>
            <DialogTitle>Register client</DialogTitle>
            <DialogDescription>
              Pre-register an agent as a trusted OAuth client. Redirect URIs are matched exactly.
            </DialogDescription>
            <div className="mt-4 space-y-4">
              <Field>
                <Label>Client name</Label>
                <Input
                  name="client_name"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  invalid={touched && !!nameError}
                />
                {touched && nameError && <ErrorMessage>{nameError}</ErrorMessage>}
              </Field>
              <Field>
                <Label>Redirect URIs</Label>
                <Description>
                  One per line. https, or http on localhost, 127.0.0.1 or [::1] (any port). For
                  Claude Code: http://localhost:33418/callback
                </Description>
                <Textarea
                  name="redirect_uris"
                  rows={3}
                  value={uriText}
                  onChange={e => setUriText(e.target.value)}
                  invalid={touched && !!uriError}
                />
                {touched && uriError && <ErrorMessage>{uriError}</ErrorMessage>}
              </Field>
            </div>
            <DialogActions>
              <Button plain type="button" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" disabled={create.isPending}>
                Register
              </Button>
            </DialogActions>
          </form>
        )}
      </DialogBody>
    </Dialog>
  );
}
