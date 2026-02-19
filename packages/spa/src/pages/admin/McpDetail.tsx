import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, CheckCircle, Archive, RefreshCw, AlertTriangle } from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  useAdminMcp,
  useUpdateMcp,
  useValidateMcp,
  usePublishMcp,
  useArchiveMcp,
} from '@/api/hooks/use-admin';
import { usePageTitle } from '@/hooks/usePageTitle';

export function McpDetail() {
  const { mcpId } = useParams<{ mcpId: string }>();
  const { data: mcp, isLoading } = useAdminMcp(mcpId!);
  usePageTitle(mcp ? `Admin - ${mcp.name}` : 'Admin - MCP Details');
  const updateMcp = useUpdateMcp();
  const validateMcp = useValidateMcp();
  const publishMcp = usePublishMcp();
  const archiveMcp = useArchiveMcp();
  const { addToast } = useToast();

  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [validationResult, setValidationResult] = useState<any>(null);

  const [editFormData, setEditFormData] = useState({
    display_name: '',
    description: '',
    icon_url: '',
    config: '',
  });

  const handleEdit = async () => {
    if (!mcp) return;
    try {
      let configObj = mcp.config;
      if (editFormData.config) {
        try {
          configObj = JSON.parse(editFormData.config);
        } catch {
          addToast({ title: 'Invalid JSON', description: 'Invalid JSON in config field', variant: 'destructive' });
          return;
        }
      }

      await updateMcp.mutateAsync({
        mcpId: mcp.mcp_id,
        data: {
          display_name: editFormData.display_name || undefined,
          description: editFormData.description || undefined,
          icon_url: editFormData.icon_url || undefined,
          config: configObj,
        },
      });
      setEditDialogOpen(false);
    } catch (error) {
      addToast({ title: 'Update MCP failed', description: (error as Error)?.message ?? String(error), variant: 'destructive' });
    }
  };

  const openEditDialog = () => {
    if (!mcp) return;
    setEditFormData({
      display_name: mcp.display_name,
      description: mcp.description || '',
      icon_url: mcp.icon_url || '',
      config: JSON.stringify(mcp.config, null, 2),
    });
    setEditDialogOpen(true);
  };

  const handleValidate = async () => {
    if (!mcp) return;
    try {
      const result = await validateMcp.mutateAsync(mcp.mcp_id);
      setValidationResult(result);
    } catch (error) {
      addToast({ title: 'Validate MCP failed', description: (error as Error)?.message ?? String(error), variant: 'destructive' });
    }
  };

  const handlePublish = async () => {
    if (!mcp) return;
    try {
      await publishMcp.mutateAsync(mcp.mcp_id);
    } catch (error) {
      addToast({ title: 'Publish MCP failed', description: (error as Error)?.message ?? String(error), variant: 'destructive' });
    }
  };

  const handleArchive = async () => {
    if (!mcp) return;
    try {
      await archiveMcp.mutateAsync(mcp.mcp_id);
    } catch (error) {
      addToast({ title: 'Archive MCP failed', description: (error as Error)?.message ?? String(error), variant: 'destructive' });
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (!mcp) {
    return (
      <div className="space-y-6">
        <Button variant="ghost" asChild>
          <Link to="/app/admin/mcps">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to MCPs
          </Link>
        </Button>
        <Card>
          <CardHeader>
            <CardTitle>MCP Not Found</CardTitle>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Button variant="ghost" asChild>
        <Link to="/app/admin/mcps">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to MCPs
        </Link>
      </Button>

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{mcp.display_name}</h1>
          <p className="text-muted-foreground font-mono text-sm">{mcp.name}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={mcp.status === 'draft' ? 'secondary' : mcp.status === 'published' ? 'default' : 'outline'}>
            {mcp.status}
          </Badge>
          {mcp.validation_status && (
            <Badge
              variant={
                mcp.validation_status === 'valid'
                  ? 'default'
                  : mcp.validation_status === 'invalid'
                  ? 'destructive'
                  : 'outline'
              }
            >
              {mcp.validation_status}
            </Badge>
          )}
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex gap-2">
        <Button variant="outline" onClick={openEditDialog}>
          Edit MCP
        </Button>
        <Button variant="outline" onClick={handleValidate} disabled={validateMcp.isPending}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Validate
        </Button>
        {mcp.status === 'draft' && mcp.validation_status === 'valid' && (
          <Button onClick={handlePublish} disabled={publishMcp.isPending}>
            <CheckCircle className="mr-2 h-4 w-4" />
            Publish
          </Button>
        )}
        {mcp.status === 'published' && (
          <Button variant="outline" onClick={handleArchive} disabled={archiveMcp.isPending}>
            <Archive className="mr-2 h-4 w-4" />
            Archive
          </Button>
        )}
      </div>

      {/* Validation Results */}
      {validationResult && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {validationResult.valid ? (
                <CheckCircle className="h-5 w-5 text-green-600" />
              ) : (
                <AlertTriangle className="h-5 w-5 text-destructive" />
              )}
              Validation {validationResult.valid ? 'Passed' : 'Failed'}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {validationResult.errors.length > 0 && (
              <div>
                <h4 className="font-medium text-destructive mb-2">Errors</h4>
                <ul className="list-disc list-inside space-y-1">
                  {validationResult.errors.map((err: string, i: number) => (
                    <li key={i} className="text-sm text-destructive">
                      {err}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {validationResult.warnings.length > 0 && (
              <div>
                <h4 className="font-medium text-yellow-600 mb-2">Warnings</h4>
                <ul className="list-disc list-inside space-y-1">
                  {validationResult.warnings.map((warn: string, i: number) => (
                    <li key={i} className="text-sm text-yellow-600">
                      {warn}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {validationResult.tools_discovered.length > 0 && (
              <div>
                <h4 className="font-medium mb-2">Discovered Tools ({validationResult.tools_discovered.length})</h4>
                <div className="grid gap-2">
                  {validationResult.tools_discovered.map((tool: any, i: number) => (
                    <div key={i} className="border rounded p-2">
                      <p className="font-mono text-sm font-medium">{tool.name}</p>
                      <p className="text-xs text-muted-foreground">{tool.description}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* MCP Details */}
      <Tabs defaultValue="info" className="w-full">
        <TabsList>
          <TabsTrigger value="info">Information</TabsTrigger>
          <TabsTrigger value="config">Configuration</TabsTrigger>
        </TabsList>
        <TabsContent value="info" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>MCP Information</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm font-medium text-muted-foreground">MCP ID</p>
                  <p className="text-sm font-mono">{mcp.mcp_id}</p>
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Internal Name</p>
                  <p className="text-sm font-mono">{mcp.name}</p>
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Display Name</p>
                  <p className="text-sm">{mcp.display_name}</p>
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Transport Type</p>
                  <p className="text-sm">{mcp.transport_type}</p>
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Isolation Mode</p>
                  <p className="text-sm">{mcp.isolation_mode}</p>
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Requires Credentials</p>
                  <p className="text-sm">{mcp.requires_user_credentials ? 'Yes' : 'No'}</p>
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Created</p>
                  <p className="text-sm">{new Date(mcp.created_at).toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Updated</p>
                  <p className="text-sm">{new Date(mcp.updated_at).toLocaleString()}</p>
                </div>
              </div>
              {mcp.description && (
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Description</p>
                  <p className="text-sm mt-1">{mcp.description}</p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="config" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Configuration</CardTitle>
              <CardDescription>MCP runtime configuration (JSON)</CardDescription>
            </CardHeader>
            <CardContent>
              <pre className="bg-muted p-4 rounded-lg overflow-x-auto text-sm">
                {JSON.stringify(mcp.config, null, 2)}
              </pre>
            </CardContent>
          </Card>
          {mcp.credential_schema && (
            <Card>
              <CardHeader>
                <CardTitle>Credential Schema</CardTitle>
                <CardDescription>Required user credentials schema</CardDescription>
              </CardHeader>
              <CardContent>
                <pre className="bg-muted p-4 rounded-lg overflow-x-auto text-sm">
                  {JSON.stringify(mcp.credential_schema, null, 2)}
                </pre>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>

      {/* Edit Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit MCP</DialogTitle>
            <DialogDescription>Update MCP configuration</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 max-h-[60vh] overflow-y-auto">
            <div className="space-y-2">
              <Label htmlFor="edit_display_name">Display Name</Label>
              <Input
                id="edit_display_name"
                value={editFormData.display_name}
                onChange={(e) =>
                  setEditFormData({ ...editFormData, display_name: e.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit_description">Description</Label>
              <Textarea
                id="edit_description"
                value={editFormData.description}
                onChange={(e) =>
                  setEditFormData({ ...editFormData, description: e.target.value })
                }
                rows={3}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit_icon_url">Icon URL</Label>
              <Input
                id="edit_icon_url"
                value={editFormData.icon_url}
                onChange={(e) =>
                  setEditFormData({ ...editFormData, icon_url: e.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit_config">Configuration (JSON)</Label>
              <Textarea
                id="edit_config"
                value={editFormData.config}
                onChange={(e) =>
                  setEditFormData({ ...editFormData, config: e.target.value })
                }
                rows={10}
                className="font-mono text-sm"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleEdit} disabled={updateMcp.isPending}>
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
