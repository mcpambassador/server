import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Trash2, Plus } from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/catalyst/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogBody, DialogDescription, DialogActions,  DialogTitle } from '@/components/catalyst/dialog';
import { Label } from '@/components/catalyst/fieldset';
import {
  Alert,
  AlertBody,
  AlertDescription,
  AlertActions,
  AlertTitle,
} from '@/components/catalyst/alert';
import { DataTable, type ColumnDef } from '@/components/data/DataTable';
import {
  useAdminGroup,
  useGroupMembers,
  useAddGroupMember,
  useRemoveGroupMember,
  useGroupMcps,
  useAssignGroupMcp,
  useRemoveGroupMcp,
  useAdminUsers,
  useAdminMcps,
} from '@/api/hooks/use-admin';
import type { GroupMember, McpCatalogEntry } from '@/api/types';
import { usePageTitle } from '@/hooks/usePageTitle';

export function GroupDetail() {
  const { groupId } = useParams<{ groupId: string }>();
  const { data: group, isLoading: groupLoading } = useAdminGroup(groupId!);
  usePageTitle(group ? `Admin - ${group.name}` : 'Admin - Group Details');
  const { data: members, isLoading: membersLoading } = useGroupMembers(groupId!);
  const { data: mcps, isLoading: mcpsLoading } = useGroupMcps(groupId!);
  const { data: allUsers } = useAdminUsers();
  const { data: allMcps } = useAdminMcps();

  const addMember = useAddGroupMember();
  const removeMember = useRemoveGroupMember();
  const assignMcp = useAssignGroupMcp();
  const removeMcp = useRemoveGroupMcp();
  const { addToast } = useToast();

  const [addMemberDialogOpen, setAddMemberDialogOpen] = useState(false);
  const [addMcpDialogOpen, setAddMcpDialogOpen] = useState(false);
  const [removeMemberDialogOpen, setRemoveMemberDialogOpen] = useState(false);
  const [removeMcpDialogOpen, setRemoveMcpDialogOpen] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [selectedMcpId, setSelectedMcpId] = useState('');
  const [memberToRemove, setMemberToRemove] = useState<GroupMember | null>(null);
  const [mcpToRemove, setMcpToRemove] = useState<McpCatalogEntry | null>(null);

  const handleAddMember = async () => {
    if (!selectedUserId) return;
    try {
      await addMember.mutateAsync({ groupId: groupId!, userId: selectedUserId });
      setAddMemberDialogOpen(false);
      setSelectedUserId('');
    } catch (error) {
      addToast({ title: 'Add member failed', description: (error as Error)?.message ?? String(error), variant: 'red' });
    }
  };

  const handleRemoveMember = async () => {
    if (!memberToRemove) return;
    try {
      await removeMember.mutateAsync({ groupId: groupId!, userId: memberToRemove.user_id });
      setRemoveMemberDialogOpen(false);
      setMemberToRemove(null);
    } catch (error) {
      addToast({ title: 'Remove member failed', description: (error as Error)?.message ?? String(error), variant: 'red' });
    }
  };

  const handleAssignMcp = async () => {
    if (!selectedMcpId) return;
    try {
      await assignMcp.mutateAsync({ groupId: groupId!, mcpId: selectedMcpId });
      setAddMcpDialogOpen(false);
      setSelectedMcpId('');
    } catch (error) {
      addToast({ title: 'Assign MCP failed', description: (error as Error)?.message ?? String(error), variant: 'red' });
    }
  };

  const handleRemoveMcp = async () => {
    if (!mcpToRemove) return;
    try {
      await removeMcp.mutateAsync({ groupId: groupId!, mcpId: mcpToRemove.mcp_id });
      setRemoveMcpDialogOpen(false);
      setMcpToRemove(null);
    } catch (error) {
      addToast({ title: 'Remove MCP failed', description: (error as Error)?.message ?? String(error), variant: 'red' });
    }
  };

  const memberColumns: ColumnDef<GroupMember>[] = [
    {
      header: 'Username',
      accessor: 'username',
      cell: (member) => (
        <Link
          to={`/app/admin/users/${member.user_id}`}
          className="font-medium hover:underline"
        >
          {member.username}
        </Link>
      ),
    },
    {
      header: 'Display Name',
      accessor: 'display_name',
      cell: (member) => member.display_name || '—',
    },
    {
      header: 'Added',
      accessor: 'added_at',
      cell: (member) => new Date(member.added_at).toLocaleDateString(),
    },
    {
      header: 'Actions',
      accessor: 'user_id',
      cell: (member) => (
        <Button
                    className="p-1"
          onClick={() => {
            setMemberToRemove(member);
            setRemoveMemberDialogOpen(true);
          }}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      ),
    },
  ];

  const mcpColumns: ColumnDef<McpCatalogEntry>[] = [
    {
      header: 'Name',
      accessor: 'display_name',
      cell: (mcp) => (
        <Link
          to={`/app/admin/mcps/${mcp.mcp_id}`}
          className="font-medium hover:underline"
        >
          {mcp.display_name}
        </Link>
      ),
    },
    {
      header: 'Transport',
      accessor: 'transport_type',
    },
    {
      header: 'Isolation',
      accessor: 'isolation_mode',
    },
    {
      header: 'Actions',
      accessor: 'mcp_id',
      cell: (mcp) => (
        <Button
                    className="p-1"
          onClick={() => {
            setMcpToRemove(mcp);
            setRemoveMcpDialogOpen(true);
          }}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      ),
    },
  ];

  if (groupLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (!group) {
    return (
      <div className="space-y-6">
        <Button plain asChild>
          <Link to="/app/admin/groups">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Groups
          </Link>
        </Button>
        <Card>
          <CardHeader>
            <CardTitle>Group Not Found</CardTitle>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Button plain className="h-8" asChild>
        <Link to="/app/admin/groups">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to Groups
        </Link>
      </Button>

      <div className="pb-4 border-b border-border mb-6">
        <h1 className="text-xl font-semibold">{group.name}</h1>
        <p className="text-sm text-muted-foreground">{group.description || 'No description'}</p>
      </div>

      {/* Group Info Card */}
      <Card>
        <CardHeader>
          <CardTitle>Group Information</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-sm font-medium text-muted-foreground">Group ID</p>
              <p className="text-sm font-mono">{group.group_id}</p>
            </div>
            <div>
              <p className="text-sm font-medium text-muted-foreground">Name</p>
              <p className="text-sm">{group.name}</p>
            </div>
            <div>
              <p className="text-sm font-medium text-muted-foreground">Created</p>
              <p className="text-sm">{new Date(group.created_at).toLocaleString()}</p>
            </div>
            <div>
              <p className="text-sm font-medium text-muted-foreground">Updated</p>
              <p className="text-sm">{new Date(group.updated_at).toLocaleString()}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Tabs for Members and MCPs */}
      <Tabs defaultValue="members" className="w-full">
        <TabsList>
          <TabsTrigger value="members">Members</TabsTrigger>
          <TabsTrigger value="mcps">MCPs</TabsTrigger>
        </TabsList>
        <TabsContent value="members" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Group Members</CardTitle>
                  <CardDescription>Users who belong to this group</CardDescription>
                </div>
                <Button onClick={() => setAddMemberDialogOpen(true)} className="h-8">
                  <Plus className="mr-2 h-4 w-4" />
                  Add Member
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <DataTable
                columns={memberColumns}
                data={members ?? []}
                isLoading={membersLoading}
                emptyMessage="No members yet."
              />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="mcps" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Assigned MCPs</CardTitle>
                  <CardDescription>MCPs available to this group</CardDescription>
                </div>
                <Button onClick={() => setAddMcpDialogOpen(true)} className="h-8">
                  <Plus className="mr-2 h-4 w-4" />
                  Assign MCP
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <DataTable
                columns={mcpColumns}
                data={mcps ?? []}
                isLoading={mcpsLoading}
                emptyMessage="No MCPs assigned."
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Add Member Dialog */}
      <Dialog open={addMemberDialogOpen} onClose={setAddMemberDialogOpen}>
        
          
            <DialogTitle>Add Member to Group</DialogTitle>
            <DialogDescription>Select a user to add to this group</DialogDescription>
          
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="user_select">User</Label>
              <select
                id="user_select"
                value={selectedUserId}
                onChange={(e) => setSelectedUserId(e.target.value)}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="">Select a user...</option>
                {allUsers?.data.map((user) => (
                  <option key={user.user_id} value={user.user_id}>
                    {user.username} {user.display_name && `(${user.display_name})`}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <DialogActions>
            <Button color="zinc" className="h-8" onClick={() => setAddMemberDialogOpen(false)}>
              Cancel
            </Button>
            <Button className="h-8" onClick={handleAddMember} disabled={!selectedUserId || addMember.isPending}>
              {addMember.isPending ? 'Adding...' : 'Add Member'}
            </Button>
          </DialogActions>
        
      </Dialog>

      {/* Add MCP Dialog */}
      <Dialog open={addMcpDialogOpen} onClose={setAddMcpDialogOpen}>
        
          
            <DialogTitle>Assign MCP to Group</DialogTitle>
            <DialogDescription>Select an MCP to assign to this group</DialogDescription>
          
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="mcp_select">MCP</Label>
              <select
                id="mcp_select"
                value={selectedMcpId}
                onChange={(e) => setSelectedMcpId(e.target.value)}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="">Select an MCP...</option>
                {allMcps?.data.filter(m => m.status === 'published').map((mcp) => (
                  <option key={mcp.mcp_id} value={mcp.mcp_id}>
                    {mcp.display_name} ({mcp.transport_type})
                  </option>
                ))}
              </select>
            </div>
          </div>
          <DialogActions>
            <Button color="zinc" className="h-8" onClick={() => setAddMcpDialogOpen(false)}>
              Cancel
            </Button>
            <Button className="h-8" onClick={handleAssignMcp} disabled={!selectedMcpId || assignMcp.isPending}>
              {assignMcp.isPending ? 'Assigning...' : 'Assign MCP'}
            </Button>
          </DialogActions>
        
      </Dialog>

      {/* Remove Member Confirmation */}
      <Alert open={removeMemberDialogOpen} onClose={setRemoveMemberDialogOpen}>
        
          
            <AlertTitle>Remove Member?</AlertTitle>
            <AlertDescription>
              Remove &quot;{memberToRemove?.username}&quot; from this group?
            </AlertDescription>
          
          <AlertActions>
            <Button plain onClick={() => setMemberToRemove(null)}>Cancel</Button>
            <Button color="red" onClick={handleRemoveMember}>Remove</Button>
          </AlertActions>
        
      </Alert>

      {/* Remove MCP Confirmation */}
      <Alert open={removeMcpDialogOpen} onClose={setRemoveMcpDialogOpen}>
        
          
            <AlertTitle>Remove MCP?</AlertTitle>
            <AlertDescription>
              Remove &quot;{mcpToRemove?.display_name}&quot; from this group?
            </AlertDescription>
          
          <AlertActions>
            <Button plain onClick={() => setMcpToRemove(null)}>Cancel</Button>
            <Button color="red" onClick={handleRemoveMcp}>Remove</Button>
          </AlertActions>
        
      </Alert>
    </div>
  );
}
