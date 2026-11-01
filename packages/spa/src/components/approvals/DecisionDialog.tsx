import { useState } from 'react';
import { toast } from 'sonner';
import { Dialog, DialogTitle, DialogBody, DialogActions } from '@/components/catalyst/dialog';
import { Button } from '@/components/catalyst/button';
import { Badge } from '@/components/catalyst/badge';
import { Text } from '@/components/catalyst/text';
import { Field, Label } from '@/components/catalyst/fieldset';
import { Textarea } from '@/components/catalyst/textarea';
import { Input } from '@/components/catalyst/input';
import {
  APPROVAL_DECISION_REASON_MAX_LENGTH,
  APPROVAL_REAUTH_REQUIRED_CODE,
  APPROVAL_REAUTH_REQUIRED_STATUS,
  type ApprovalRequestDetail,
} from '@mcpambassador/contracts';
import { useApproval, useDecideApproval, useReauth } from '@/api/hooks/use-approvals';
import { visibleText } from '@/lib/pin-text';
import { ApprovalPreview } from './ApprovalPreview';

const errCode = (e: unknown) => (e as { code?: string })?.code;
const errStatus = (e: unknown) => (e as { status?: number })?.status;
const errMsg = (e: unknown) => (e as Error)?.message ?? String(e);

/** The server asks for a fresh step-up with HTTP 428 + `reauth_required` (ADR-023 §5). */
const needsReauth = (e: unknown) =>
  errStatus(e) === APPROVAL_REAUTH_REQUIRED_STATUS || errCode(e) === APPROVAL_REAUTH_REQUIRED_CODE;

export function DecisionDialog({
  approvalId,
  isAdmin,
  selfId,
  onClose,
}: {
  approvalId: string;
  isAdmin: boolean;
  /** The signed-in user's id. */
  selfId: string;
  onClose: () => void;
}) {
  const { data: d, isLoading, error } = useApproval(isAdmin, approvalId);
  // The admin routes show an admin's own owner-class request read-only; the owner route decides it.
  const ownRequestViaOwnerRoute =
    isAdmin && !!d && d.read_only && d.required_approver === 'owner' && d.user_id === selfId;
  const decide = useDecideApproval(isAdmin, ownRequestViaOwnerRoute);
  const reauth = useReauth();
  const [readAll, setReadAll] = useState(false);
  const [reason, setReason] = useState('');
  const [password, setPassword] = useState('');
  const [needReauth, setNeedReauth] = useState(false);
  const busy = decide.isPending || reauth.isPending;

  const submit = async (detail: ApprovalRequestDetail, decision: 'approve' | 'deny') => {
    try {
      // Step-up first when admin approval is required, or when the server asked for it.
      if (password) {
        await reauth.mutateAsync({ password });
        setPassword('');
      }
      await decide.mutateAsync({
        approvalId,
        decision,
        expected_args_hash: detail.args_hash,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      toast.success(decision === 'approve' ? 'Approved' : 'Denied');
      onClose();
    } catch (e) {
      setPassword('');
      if (needsReauth(e)) {
        setNeedReauth(true);
        toast.error('Confirm your password to continue');
      } else {
        toast.error('Could not record the decision', { description: errMsg(e) });
      }
    }
  };

  const loadFailed = !!error;
  const open = d?.status === 'pending';
  const readOnly = !!d && d.read_only && !ownRequestViaOwnerRoute;
  const stepUp = !!d && (d.required_approver === 'admin' || needReauth);
  const needPassword = stepUp && password.length === 0;
  const canApprove =
    !!d &&
    open &&
    !readOnly &&
    !d.definition_changed &&
    d.preview !== null &&
    readAll &&
    !needPassword &&
    !busy;
  const canDeny = !!d && open && !readOnly && !busy;

  return (
    <Dialog open onClose={onClose} size="3xl">
      <DialogTitle>
        Approval request
        {d && (
          <>
            {': '}
            <span data-testid="approval-tool">{visibleText(d.tool_name)}</span>
          </>
        )}
      </DialogTitle>
      <DialogBody className="space-y-4">
        {isLoading && <Text>Loading…</Text>}
        {loadFailed && (
          <Text data-testid="approval-load-error" className="text-red-600">
            This request could not be loaded. It may not exist, or it may not belong to you.
          </Text>
        )}
        {d && (
          <>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
              <Text>
                Agent: <strong data-testid="approval-agent">{visibleText(d.grant_label)}</strong>
              </Text>
              <Text>
                MCP: <strong>{visibleText(d.mcp_name)}</strong>
              </Text>
              <Text>
                Client: <code>{visibleText(d.bound_client_id ?? 'none')}</code>
              </Text>
              <Text>
                Arguments hash: <code data-testid="approval-hash">{d.args_hash.slice(0, 12)}</code>
              </Text>
              <Text>Expires: {new Date(d.expires_at).toLocaleString()}</Text>
              <Text>
                Status: <Badge>{d.status}</Badge>
                {d.required_approver === 'admin' && <Badge color="amber"> admin only</Badge>}
              </Text>
            </div>
            {d.definition_changed && (
              <div
                role="alert"
                data-testid="definition-changed"
                className="rounded-lg bg-red-50 p-3 text-sm font-medium text-red-700 ring-1 ring-red-200 dark:bg-red-950/30 dark:text-red-300"
              >
                The tool definition changed since this request was made. It cannot be approved; the
                agent&apos;s call will fail. Deny it or let it expire.
              </div>
            )}
            {readOnly && open && (
              <Text data-testid="read-only-note" className="text-amber-600">
                This tool needs an administrator to approve. You can see the request but not decide
                it.
              </Text>
            )}
            {!open && (
              <Text data-testid="closed-note">
                This request is {d.status}
                {d.void_reason ? ` (${d.void_reason.replace(/_/g, ' ')})` : ''}; nothing more can be
                done.
              </Text>
            )}
            {open && (
              <>
                <Text className="font-medium">Arguments the agent wants to send</Text>
                <ApprovalPreview preview={d.preview} onReadAll={setReadAll} />
                {!readAll && !readOnly && !d.definition_changed && d.preview !== null && (
                  <Text data-testid="read-warning" className="text-xs text-amber-600">
                    Open the full arguments and scroll to the end to enable Approve.
                  </Text>
                )}
              </>
            )}
            {open && !readOnly && (
              <>
                {stepUp && (
                  <Field>
                    <Label>Confirm your password to decide</Label>
                    <Input
                      type="password"
                      autoComplete="current-password"
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      data-testid="reauth-password"
                    />
                  </Field>
                )}
                <Field>
                  <Label>Reason (optional, max {APPROVAL_DECISION_REASON_MAX_LENGTH})</Label>
                  <Textarea
                    value={reason}
                    maxLength={APPROVAL_DECISION_REASON_MAX_LENGTH}
                    onChange={e => setReason(e.target.value)}
                    rows={2}
                    data-testid="decision-reason"
                  />
                </Field>
              </>
            )}
          </>
        )}
      </DialogBody>
      <DialogActions>
        <Button plain onClick={onClose} disabled={busy}>
          Close
        </Button>
        {d && open && !readOnly && (
          <>
            <Button
              color="red"
              data-testid="deny-btn"
              disabled={!canDeny || (needReauth && password.length === 0)}
              onClick={() => void submit(d, 'deny')}
            >
              Deny
            </Button>
            <Button
              color="green"
              data-testid="approve-btn"
              disabled={!canApprove}
              onClick={() => void submit(d, 'approve')}
            >
              Approve
            </Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  );
}
