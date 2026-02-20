import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeftIcon, TrashIcon, PlusIcon } from '@heroicons/react/20/solid';
import { toast } from 'sonner';
import { Heading } from '@/components/catalyst/heading';
import { Text } from '@/components/catalyst/text';
import { Button } from '@/components/catalyst/button';
import { Table, TableHead, TableBody, TableRow, TableHeader, TableCell } from '@/components/catalyst/table';
import { Tabs, TabsContent, TabsList, TabsTrigger, TabsPanels } from '@/components/catalyst/tabs';
import { Dialog, DialogBody, DialogTitle, DialogDescription, DialogActions } from '@/components/catalyst/dialog';
import { Alert, AlertTitle, AlertDescription, AlertActions } from '@/components/catalyst/alert';
import { Field, Label } from '@/components/catalyst/fieldset';
import { Select } from '@/components/catalyst/select';
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
      toast.error('Add member failed', { description: (error as Error)?.message ?? String(error) });
    }
  };

  const handleRemoveMember = async () => {
    if (!memberToRemove) return;
    try {
      await removeMember.mutateAsync({ groupId: groupId!, userId: memberToRemove.user_id });
      setRemoveMemberDialogOpen(false);
      setMemberToRemove(null);
    } catch (error) {
      toast.error('Remove member failed', { description: (error as Error)?.message ?? String(error) });
    }
  };

  const handleAssignMcp = async () => {
    if (!selectedMcpId) return;
    try {
      await assignMcp.mutateAsync({ groupId: groupId!, mcpId: selectedMcpId });
      setAddMcpDialogOpen(false);
      setSelectedMcpId('');
    } catch (error) {
      toast.error('Assign MCP failed', { description: (error as Error)?.message ?? String(error) });
    }
  };

  const handleRemoveMcp = async () => {
    if (!mcpToRemove) return;
    try {
      await removeMcp.mutateAsync({ groupId: groupId!, mcpId: mcpToRemove.mcp_id });
      setRemoveMcpDialogOpen(false);
      setMcpToRemove(null);
    } catch (error) {
      toast.error('Remove MCP failed', { description: (error as Error)?.message ?? String(error) });
    }
  };

  if (groupLoading) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-64 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
        <div className="h-48 w-full animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
      </div>
    );
  }

  if (!group) {
    return (
      <div className="space-y-6">
        <Button plain href="/app/admin/groups">
          <ArrowLeftIcon data-slot="icon" />
          Back to Groups
        </Button>
        <div className="rounded-lg bg-white dark:bg-white/5 p-6 ring-1 ring-zinc-950/5 dark:ring-white/10">
          <Heading>Group Not Found</Heading>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Back Button */}
      <Button plain href="/app/admin/groups">
        <ArrowLeftIcon data-slot="icon" />
        Back to Groups
      </Button>

      {/* Page Header */}
      <div className="space-y-1">
        <Heading>{group.name}</Heading>
        <Text>{group.description || 'No description'}</Text>
      </div>

      {/* Group Information Panel */}
      <div className="rounded-lg bg-white dark:bg-white/5 p-6 ring-1 ring-zinc-950/5 dark:ring-white/10">
        <Heading level={2}>Group Information</Heading>
        <dl className="mt-6 grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          <div>
            <dt className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Group ID</dt>
            <dd className="mt-1 text-sm font-mono text-zinc-900 dark:text-white">{group.group_id}</dd>
          </div>
          <div>
            <dt className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Name</dt>
            <dd className="mt-1 text-sm text-zinc-900 dark:text-white">{group.name}</dd>
          </div>
          <div>
            <dt className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Created</dt>
            <dd className="mt-1 text-sm text-zinc-900 dark:text-white">{new Date(group.created_at).toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Updated</dt>
            <dd className="mt-1 text-sm text-zinc-900 dark:text-white">{new Date(group.updated_at).toLocaleString()}</dd>
          </div>
        </dl>
      </div>

      {/* Tabs for Members and MCPs */}
      <Tabs defaultIndex={0} className="w-full">
        <TabsList>
          <TabsTrigger>Members</TabsTrigger>
          <TabsTrigger>MCPs</TabsTrigger>
        </TabsList>
        <TabsPanels>
          {/* Members Tab */}
          <TabsContent className="space-y-4">
            <div className="rounded-lg bg-white dark:bg-white/5 ring-1 ring-zinc-950/5 dark:ring-white/10">
              <div className="flex items-center justify-between border-b border-zinc-950/5 dark:border-white/10 px-6 py-4">
                <div>
                  <Heading level={2}>Group Members</Heading>
                  <Text>Users who belong to this group</Text>
                </div>
                <Button onClick={() => setAddMemberDialogOpen(true)}>
                  <PlusIcon data-slot="icon" />
                  Add Member
                </Button>
              </div>
              <div className="p-6">
                {membersLoading ? (
                  <div className="space-y-3">
                    <div className="h-10 w-full animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
                    <div className="h-10 w-full animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
                    <div className="h-10 w-full animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
                  </div>
                ) : !members || members.length === 0 ? (
                  <div className="py-12 text-center">
                    <Text>No members yet.</Text>
                  </div>
                ) : (
                  <Table>
                    <TableHead>
                      <TableRow>
                        <TableHeader>Username</TableHeader>
                        <TableHeader>Display Name</TableHeader>
                        <TableHeader>Added</TableHeader>
                        <TableHeader>Actions</TableHeader>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {members.map((member) => (
                        <TableRow key={member.user_id}>
                          <TableCell>
                            <Link
                              to={`/app/admin/users/${member.user_id}`}
                              className="font-medium text-zinc-900 dark:text-white hover:underline"
                            >
                              {member.username}
                            </Link>
                          </TableCell>
                          <TableCell className="text-zinc-500 dark:text-zinc-400">
                            {member.display_name || '—'}
                          </TableCell>
                          <TableCell className="text-zinc-500 dark:text-zinc-400">
                            {new Date(member.added_at).toLocaleDateString()}
                          </TableCell>
                          <TableCell>
                            <Button
                              plain
                              onClick={() => {
                                setMemberToRemove(member);
                                setRemoveMemberDialogOpen(true);
                              }}
                            >
                              <TrashIcon />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </div>
            </div>
          </TabsContent>

          {/* MCPs Tab */}
          <TabsContent className="space-y-4">
            <div className="rounded-lg bg-white dark:bg-white/5 ring-1 ring-zinc-950/5 dark:ring-white/10">
              <div className="flex items-center justify-between border-b border-zinc-950/5 dark:border-white/10 px-6 py-4">
                <div>
                  <Heading level={2}>Assigned MCPs</Heading>
                  <Text>MCPs available to this group</Text>
                </div>
                <Button onClick={() => setAddMcpDialogOpen(true)}>
                  <PlusIcon data-slot="icon" />
                  Assign MCP
                </Button>
              </div>
              <div className="p-6">
                {mcpsLoading ? (
                  <div className="space-y-3">
                    <div className="h-10 w-full animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
                    <div className="h-10 w-full animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
                    <div className="h-10 w-full animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
                  </div>
                ) : !mcps || mcps.length === 0 ? (
                  <div className="py-12 text-center">
                    <Text>No MCPs assigned.</Text>
                  </div>
                ) : (
                  <Table>
                    <TableHead>
                      <TableRow>
                        <TableHeader>Name</TableHeader>
                        <TableHeader>Transport</TableHeader>
                        <TableHeader>Isolation</TableHeader>
                        <TableHeader>Actions</TableHeader>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {mcps.map((mcp) => (
                        <TableRow key={mcp.mcp_id}>
                          <TableCell>
                            <Link
                              to={`/app/admin/mcps/${mcp.mcp_id}`}
                              className="font-medium text-zinc-900 dark:text-white hover:underline"
                            >
                              {mcp.display_name}
                            </Link>
                          </TableCell>
                          <TableCell className="text-zinc-500 dark:text-zinc-400">
                            {mcp.transport_type}
                          </TableCell>
                          <TableCell className="text-zinc-500 dark:text-zinc-400">
                            {mcp.isolation_mode}
                          </TableCell>
                          <TableCell>
                            <Button
                              plain
                              onClick={() => {
                                setMcpToRemove(mcp);
                                setRemoveMcpDialogOpen(true);
                              }}
                            >
                              <TrashIcon />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </div>
            </div>
          </TabsContent>
        </TabsPanels>
      </Tabs>

      {/* Add Member Dialog */}
      <Dialog open={addMemberDialogOpen} onClose={setAddMemberDialogOpen}>
        <DialogTitle>Add Member to Group</DialogTitle>
        <DialogDescription>Select a user to add to this group</DialogDescription>
        <DialogBody>
          <Field>
            <Label>User</Label>
            <Select
              name="user-select"
              value={selectedUserId}
              onChange={(e) => setSelectedUserId(e.target.value)}
            >
              <option value="">Select a user...</option>
              {allUsers?.data.map((user) => (
                <option key={user.user_id} value={user.user_id}>
                  {user.username} {user.display_name && `(${user.display_name})`}
                </option>
              ))}
            </Select>
          </Field>
        </DialogBody>
        <DialogActions>
          <Button plain onClick={() => setAddMemberDialogOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleAddMember} disabled={!selectedUserId || addMember.isPending}>
            {addMember.isPending ? 'Adding...' : 'Add Member'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Add MCP Dialog */}
      <Dialog open={addMcpDialogOpen} onClose={setAddMcpDialogOpen}>
        <DialogTitle>Assign MCP to Group</DialogTitle>
        <DialogDescription>Select an MCP to assign to this group</DialogDescription>
        <DialogBody>
          <Field>
            <Label>MCP</Label>
            <Select
              name="mcp-select"
              value={selectedMcpId}
              onChange={(e) => setSelectedMcpId(e.target.value)}
            >
              <option value="">Select an MCP...</option>
              {allMcps?.data.filter(m => m.status === 'published').map((mcp) => (
                <option key={mcp.mcp_id} value={mcp.mcp_id}>
                  {mcp.display_name} ({mcp.transport_type})
                </option>
              ))}
            </Select>
          </Field>
        </DialogBody>
        <DialogActions>
          <Button plain onClick={() => setAddMcpDialogOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleAssignMcp} disabled={!selectedMcpId || assignMcp.isPending}>
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
          <Button plain onClick={() => setRemoveMemberDialogOpen(false)}>
            Cancel
          </Button>
          <Button color="red" onClick={handleRemoveMember}>
            Remove
          </Button>
        </AlertActions>
      </Alert>

      {/* Remove MCP Confirmation */}
      <Alert open={removeMcpDialogOpen} onClose={setRemoveMcpDialogOpen}>
        <AlertTitle>Remove MCP?</AlertTitle>
        <AlertDescription>
          Remove &quot;{mcpToRemove?.display_name}&quot; from this group?
        </AlertDescription>
        <AlertActions>
          <Button plain onClick={() => setRemoveMcpDialogOpen(false)}>
            Cancel
          </Button>
          <Button color="red" onClick={handleRemoveMcp}>
            Remove
          </Button>
        </AlertActions>
      </Alert>
    </div>
  );
}
