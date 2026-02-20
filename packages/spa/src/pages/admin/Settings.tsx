import { useState } from 'react';
import { AlertTriangle, Key, Trash2, Shield } from 'lucide-react';
import { toast } from 'sonner';
import { Heading } from '@/components/catalyst/heading';
import { Text } from '@/components/catalyst/text';
import { Button } from '@/components/catalyst/button';
import { Badge } from '@/components/catalyst/badge';
import { Table, TableHead, TableBody, TableRow, TableHeader, TableCell } from '@/components/catalyst/table';
import { Alert, AlertTitle, AlertDescription, AlertActions } from '@/components/catalyst/alert';
import { useDownstream, useAdminSessions, useKillSession, useRotateHmac, useRotateCredentialKey } from '@/api/hooks/use-admin';
import type { Session } from '@/api/types';
import { usePageTitle } from '@/hooks/usePageTitle';

export function Settings() {
  usePageTitle('Admin - Settings');
  const { data: downstream } = useDownstream();
  const { data: sessions, isLoading: sessionsLoading } = useAdminSessions();
  const killSession = useKillSession();
  const rotateHmac = useRotateHmac();
  const rotateCredentialKey = useRotateCredentialKey();

  const [hmacDialogOpen, setHmacDialogOpen] = useState(false);
  const [credKeyDialogOpen, setCredKeyDialogOpen] = useState(false);
  const [killSessionDialogOpen, setKillSessionDialogOpen] = useState(false);
  const [sessionToKill, setSessionToKill] = useState<Session | null>(null);

  const handleRotateHmac = async () => {
    try {
      await rotateHmac.mutateAsync();
      setHmacDialogOpen(false);
      toast.success('HMAC rotated', { description: 'HMAC secret rotated successfully' });
    } catch (error) {
      toast.error('Rotate HMAC failed', { description: (error as Error)?.message ?? String(error) });
    }
  };

  const handleRotateCredentialKey = async () => {
    try {
      await rotateCredentialKey.mutateAsync();
      setCredKeyDialogOpen(false);
      toast.success('Credential key rotated', { description: 'Credential encryption key rotated successfully' });
    } catch (error) {
      toast.error('Rotate credential key failed', { description: (error as Error)?.message ?? String(error) });
    }
  };

  const handleKillSession = async () => {
    if (!sessionToKill) return;
    try {
      await killSession.mutateAsync(sessionToKill.session_id);
      setKillSessionDialogOpen(false);
      setSessionToKill(null);
    } catch (error) {
      toast.error('Kill session failed', { description: (error as Error)?.message ?? String(error) });
    }
  };

  const sessionList = Array.isArray(sessions) ? sessions : (sessions?.data ?? []);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <Heading>Settings</Heading>
        <Text>System configuration and dangerous operations</Text>
      </div>

      {/* System Status */}
      <div className="rounded-lg bg-white p-6 ring-1 ring-zinc-950/5">
        <h3 className="text-base/7 font-semibold text-zinc-900">System Status</h3>
        <p className="mt-1 text-sm/6 text-zinc-500">Current system health metrics</p>
        
        {downstream ? (
          <div className="mt-6 grid grid-cols-3 gap-6">
            <div>
              <p className="text-xs font-medium text-zinc-500">Downstream Connections</p>
              <p className="mt-2 text-2xl font-semibold text-zinc-900">
                {downstream.healthy_connections}/{downstream.total_connections}
              </p>
            </div>
            <div>
              <p className="text-xs font-medium text-zinc-500">Total Tools</p>
              <p className="mt-2 text-2xl font-semibold text-zinc-900">{downstream.total_tools}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-zinc-500">Health Status</p>
              <div className="mt-2">
                <Badge
                  color={
                    downstream.healthy_connections === downstream.total_connections
                      ? 'green'
                      : 'red'
                  }
                >
                  {downstream.healthy_connections === downstream.total_connections
                    ? 'Healthy'
                    : 'Degraded'}
                </Badge>
              </div>
            </div>
          </div>
        ) : (
          <p className="mt-4 text-sm text-zinc-500">No system data available</p>
        )}
      </div>

      {/* Active Sessions */}
      <div className="rounded-lg bg-white p-6 ring-1 ring-zinc-950/5">
        <h3 className="text-base/7 font-semibold text-zinc-900">Active Sessions</h3>
        <p className="mt-1 text-sm/6 text-zinc-500">Currently authenticated user sessions</p>
        
        <div className="mt-6">
          {sessionsLoading ? (
            <div className="space-y-3">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="h-12 animate-pulse rounded-lg bg-zinc-100" />
              ))}
            </div>
          ) : sessionList.length === 0 ? (
            <p className="text-sm text-zinc-500">No active sessions</p>
          ) : (
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeader>Username</TableHeader>
                  <TableHeader>User ID</TableHeader>
                  <TableHeader>IP Address</TableHeader>
                  <TableHeader>Created</TableHeader>
                  <TableHeader>Expires</TableHeader>
                  <TableHeader>Actions</TableHeader>
                </TableRow>
              </TableHead>
              <TableBody>
                {sessionList.map((session) => (
                  <TableRow key={session.session_id}>
                    <TableCell className="font-medium">{session.username}</TableCell>
                    <TableCell>
                      <code className="text-xs font-mono text-zinc-600">{session.user_id}</code>
                    </TableCell>
                    <TableCell>
                      <code className="text-xs font-mono text-zinc-600">
                        {session.ip_address || '—'}
                      </code>
                    </TableCell>
                    <TableCell className="text-zinc-600">
                      {new Date(session.created_at).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-zinc-600">
                      {new Date(session.expires_at).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <Button
                        plain
                        onClick={() => {
                          setSessionToKill(session);
                          setKillSessionDialogOpen(true);
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </div>

      {/* Dangerous Operations */}
      <div className="rounded-lg bg-white p-6 ring-1 ring-red-200">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-red-600" />
          <h3 className="text-base/7 font-semibold text-red-900">Dangerous Operations</h3>
        </div>
        <p className="mt-1 text-sm/6 text-red-700">
          These operations can disrupt service. Use with extreme caution.
        </p>

        <div className="mt-4 space-y-4">
          {/* Rotate HMAC Secret */}
          <div className="flex items-center justify-between rounded-lg bg-red-50 p-4">
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <Key className="h-4 w-4 text-red-700" />
                <p className="font-medium text-red-900">Rotate HMAC Secret</p>
              </div>
              <p className="mt-1 text-sm text-red-700">
                Invalidates all existing API keys. Clients must obtain new keys.
              </p>
            </div>
            <Button
              color="red"
              onClick={() => setHmacDialogOpen(true)}
              disabled={rotateHmac.isPending}
            >
              <Shield className="h-4 w-4" />
              Rotate
            </Button>
          </div>

          {/* Rotate Credential Encryption Key */}
          <div className="flex items-center justify-between rounded-lg bg-red-50 p-4">
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <Key className="h-4 w-4 text-red-700" />
                <p className="font-medium text-red-900">Rotate Credential Encryption Key</p>
              </div>
              <p className="mt-1 text-sm text-red-700">
                Re-encrypts all stored credentials with a new key. May cause temporary service
                disruption.
              </p>
            </div>
            <Button
              color="red"
              onClick={() => setCredKeyDialogOpen(true)}
              disabled={rotateCredentialKey.isPending}
            >
              <Shield className="h-4 w-4" />
              Rotate
            </Button>
          </div>
        </div>
      </div>

      {/* HMAC Rotation Confirmation */}
      <Alert open={hmacDialogOpen} onClose={setHmacDialogOpen}>
        <AlertTitle>Rotate HMAC Secret?</AlertTitle>
        <AlertDescription>
          This will invalidate ALL existing API keys. All clients will need to generate new
          keys. This action cannot be undone.
        </AlertDescription>
        <AlertActions>
          <Button plain onClick={() => setHmacDialogOpen(false)}>
            Cancel
          </Button>
          <Button color="red" onClick={handleRotateHmac}>
            Rotate HMAC Secret
          </Button>
        </AlertActions>
      </Alert>

      {/* Credential Key Rotation Confirmation */}
      <Alert open={credKeyDialogOpen} onClose={setCredKeyDialogOpen}>
        <AlertTitle>Rotate Credential Encryption Key?</AlertTitle>
        <AlertDescription>
          This will re-encrypt all stored user credentials. The operation may take several
          seconds. Users may experience brief service disruption.
        </AlertDescription>
        <AlertActions>
          <Button plain onClick={() => setCredKeyDialogOpen(false)}>
            Cancel
          </Button>
          <Button color="red" onClick={handleRotateCredentialKey}>
            Rotate Credential Key
          </Button>
        </AlertActions>
      </Alert>

      {/* Kill Session Confirmation */}
      <Alert open={killSessionDialogOpen} onClose={setKillSessionDialogOpen}>
        <AlertTitle>Kill Session?</AlertTitle>
        <AlertDescription>
          This will immediately terminate the session for {sessionToKill?.username}. They
          will be logged out.
        </AlertDescription>
        <AlertActions>
          <Button plain onClick={() => {
            setKillSessionDialogOpen(false);
            setSessionToKill(null);
          }}>
            Cancel
          </Button>
          <Button color="red" onClick={handleKillSession}>
            Kill Session
          </Button>
        </AlertActions>
      </Alert>
    </div>
  );
}
