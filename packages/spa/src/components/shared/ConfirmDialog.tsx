import { ReactNode } from 'react';
import { Dialog, DialogTitle, DialogDescription, DialogBody, DialogActions } from '@/components/catalyst/dialog';
import { Button } from '@/components/catalyst/button';

export interface ConfirmDialogProps {
  open: boolean;
  onClose: (value: boolean) => void;
  title: string;
  description?: string | ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmColor?: 'red' | 'amber' | 'zinc';
  onConfirm: () => void | Promise<void>;
  isLoading?: boolean;
}

export function ConfirmDialog({
  open,
  onClose,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  confirmColor = 'red',
  onConfirm,
  isLoading = false,
}: ConfirmDialogProps) {
  const handleConfirm = async () => {
    await onConfirm();
  };

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogBody>
        <DialogTitle>{title}</DialogTitle>
        {description && (
          <DialogDescription>
            {description}
          </DialogDescription>
        )}
        <DialogActions>
          <Button color="zinc" onClick={() => onClose(false)} disabled={isLoading}>
            {cancelLabel}
          </Button>
          <Button color={confirmColor} onClick={handleConfirm} disabled={isLoading}>
            {isLoading ? 'Processing...' : confirmLabel}
          </Button>
        </DialogActions>
      </DialogBody>
    </Dialog>
  );
}
