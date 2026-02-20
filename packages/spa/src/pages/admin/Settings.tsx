import { useState } from 'react';
import { AlertTriangle, Key, Trash2, Shield } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/catalyst/card';
import { Button } from '@/components/catalyst/button';
import { Badge } from '@/components/catalyst/badge';
import {
  Alert,
  AlertBody,
  AlertDescription,
  AlertActions,
  AlertTitle,
} from '@/components/catalyst/alert';
import { DataTable, type ColumnDef } from '@/components/data/DataTable';
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

  const sessionColumns: ColumnDef<Session>[] = [
    {
      header: 'Username',
      accessor: 'username',
    },
    {
      header: 'User ID',
      accessor: 'user_id',
      cell: (session) => <code className="text-xs">{session.user_id}</code>,
    },
    {
      header: 'IP Address',
      accessor: 'ip_address',
      cell: (session) => <code className="text-xs">{session.ip_address || '—'}</code>,
    },
    {
      header: 'Created',
      accessor: 'created_at',
      cell: (session) => new Date(session.created_at).toLocaleString(),
    },
    {
      header: 'Expires',
      accessor: 'expires_at',
      cell: (session) => new Date(session.expires_at).toLocaleString(),
    },
    {
      header: 'Actions',
      accessor: 'session_id',
      cell: (session) => (
        <Button
                    className="p-1"
          onClick={() => {
            setSessionToKill(session);
            setKillSessionDialogOpen(true);
          }}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="pb-4 border-b border-border mb-6">
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">
          System configuration and dangerous operations
        </p>
      </div>

      {/* System Status */}
      <Card>
        <CardHeader>
          <CardTitle>System Status</CardTitle>
          <CardDescription>Current system health metrics</CardDescription>
        </CardHeader>
        <CardContent>
          {downstream ? (
            <div className="grid grid-cols-3 gap-4">
              <div>
                <p className="text-xs text-muted-foreground">Downstream Connections</p>
                <p className="text-2xl font-bold">
                  {downstream.healthy_connections}/{downstream.total_connections}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Total Tools</p>
                <p className="text-2xl font-bold">{downstream.total_tools}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Health Status</p>
                <Badge
                  color={
                    downstream.healthy_connections === downstream.total_connections
                      ? 'emerald'
                      : 'red'
                  }
                >
                  {downstream.healthy_connections === downstream.total_connections
                    ? 'Healthy'
                    : 'Degraded'}
                </Badge>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No system data available</p>
          )}
        </CardContent>
      </Card>

      {/* Active Sessions */}
      <Card>
        <CardHeader>
          <CardTitle>Active Sessions</CardTitle>
          <CardDescription>Currently authenticated user sessions</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={sessionColumns}
            data={Array.isArray(sessions) ? sessions : []}
            isLoading={sessionsLoading}
            emptyMessage="No active sessions"
          />
        </CardContent>
      </Card>

      {/* Dangerous Operations */}
      <Card className="border-destructive">
        <CardHeader>
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            <CardTitle className="text-destructive">Dangerous Operations</CardTitle>
          </div>
          <CardDescription>
            These operations can disrupt service. Use with extreme caution.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between p-4 border border-destructive rounded-lg">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <Key className="h-4 w-4" />
                <p className="font-medium">Rotate HMAC Secret</p>
              </div>
              <p className="text-sm text-muted-foreground">
                Invalidates all existing API keys. Clients must obtain new keys.
              </p>
            </div>
            <Button
              color="red"
              className="h-8"
              onClick={() => setHmacDialogOpen(true)}
              disabled={rotateHmac.isPending}
            >
              <Shield className="mr-2 h-4 w-4" />
              Rotate
            </Button>
          </div>

          <div className="flex items-center justify-between p-4 border border-destructive rounded-lg">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <Key className="h-4 w-4" />
                <p className="font-medium">Rotate Credential Encryption Key</p>
              </div>
              <p className="text-sm text-muted-foreground">
                Re-encrypts all stored credentials with a new key. May cause temporary service
                disruption.
              </p>
            </div>
            <Button
              color="red"
              className="h-8"
              onClick={() => setCredKeyDialogOpen(true)}
              disabled={rotateCredentialKey.isPending}
            >
              <Shield className="mr-2 h-4 w-4" />
              Rotate
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* HMAC Rotation Confirmation */}
      <Alert open={hmacDialogOpen} onClose={setHmacDialogOpen}>
        
          
            <AlertTitle>Rotate HMAC Secret?</AlertTitle>
            <AlertDescription>
              This will invalidate ALL existing API keys. All clients will need to generate new
              keys. This action cannot be undone.
            </AlertDescription>
          
          <AlertActions>
            <Button plain onClick={() => setRotateHmacDialog(false)}>Cancel</Button>
            <Button color="red"
              onClick={handleRotateHmac}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
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
            <Button plain onClick={() => setRotateCredentialDialog(false)}>Cancel</Button>
            <Button color="red"
              onClick={handleRotateCredentialKey}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
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
            <Button plain onClick={() => setSessionToKill(null)}>
              Cancel
            </Button>
            <Button color="red"
              onClick={handleKillSession}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Kill Session
            </Button>
          </AlertActions>
        
      </Alert>
    </div>
  );
}
