import { ArrowDownTrayIcon } from '@heroicons/react/20/solid';
import { Badge } from '@/components/catalyst/badge';
import { Button } from '@/components/catalyst/button';
import { Input } from '@/components/catalyst/input';
import { Field, Label } from '@/components/catalyst/fieldset';
import { Textarea } from '@/components/catalyst/textarea';
import { Listbox, ListboxOption, ListboxLabel } from '@/components/catalyst/listbox';

interface BasicInfoStepProps {
  formData: {
    name: string;
    display_name: string;
    description: string;
    icon_url: string;
    transport_type: 'stdio' | 'http' | 'sse';
    isolation_mode: 'shared' | 'per_user';
  };
  errors: Record<string, string>;
  createdMcpId: string | null;
  importedFromRegistry: string | null;
  onChange: (patch: Partial<BasicInfoStepProps['formData']>) => void;
  onOpenRegistryModal: () => void;
}

export function BasicInfoStep({
  formData,
  errors,
  createdMcpId,
  importedFromRegistry,
  onChange,
  onOpenRegistryModal,
}: BasicInfoStepProps) {
  return (
    <>
      {/* Registry import shortcut — only available before an MCP has been created */}
      {!createdMcpId && (
        <div className="flex items-center justify-between rounded-lg bg-zinc-50 dark:bg-zinc-800/50 px-4 py-3 ring-1 ring-zinc-200 dark:ring-zinc-700 mb-2">
          <div className="flex-1 min-w-0">
            {importedFromRegistry ? (
              <p className="text-sm text-zinc-700 dark:text-zinc-300">
                <span className="font-medium">Imported from registry:</span>{' '}
                <Badge color="blue">{importedFromRegistry}</Badge>
                <span className="ml-2 text-zinc-500 dark:text-zinc-400 text-xs">
                  All fields pre-filled — review and edit before continuing.
                </span>
              </p>
            ) : (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                Browse the community registry to pre-fill all fields automatically.
              </p>
            )}
          </div>
          <Button
            color="zinc"
            onClick={onOpenRegistryModal}
            className="ml-4 shrink-0"
          >
            <ArrowDownTrayIcon data-slot="icon" />
            {importedFromRegistry ? 'Change Registry Entry' : 'Import from Registry'}
          </Button>
        </div>
      )}

      <Field>
        <Label>Internal Name * (e.g., github, slack)</Label>
        <Input
          value={formData.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="github"
          disabled={!!createdMcpId}
          aria-invalid={!!errors.name}
          aria-describedby={errors.name ? 'name-error' : undefined}
        />
        {errors.name && (
          <p id="name-error" className="text-xs text-red-600 dark:text-red-400 mt-1">
            {errors.name}
          </p>
        )}
        {createdMcpId && (
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
            Internal name cannot be changed after creation. Delete this draft and start over if a different name is needed.
          </p>
        )}
      </Field>

      <Field>
        <Label>Display Name *</Label>
        <Input
          value={formData.display_name}
          onChange={(e) => onChange({ display_name: e.target.value })}
          placeholder="GitHub"
          aria-invalid={!!errors.display_name}
          aria-describedby={errors.display_name ? 'display-name-error' : undefined}
        />
        {errors.display_name && (
          <p id="display-name-error" className="text-xs text-red-600 dark:text-red-400 mt-1">
            {errors.display_name}
          </p>
        )}
      </Field>

      <Field>
        <Label>Description</Label>
        <Textarea
          value={formData.description}
          onChange={(e) => onChange({ description: e.target.value })}
          rows={3}
          placeholder="Interact with GitHub repositories and issues"
        />
      </Field>

      <Field>
        <Label>Icon URL</Label>
        <Input
          value={formData.icon_url}
          onChange={(e) => onChange({ icon_url: e.target.value })}
          placeholder="https://..."
        />
      </Field>

      <Field>
        <Label>Transport Type</Label>
        <Listbox
          name="transport-type"
          value={formData.transport_type}
          onChange={(value: string) =>
            onChange({ transport_type: value as 'stdio' | 'http' | 'sse' })
          }
        >
          <ListboxOption value="stdio">
            <ListboxLabel>stdio</ListboxLabel>
          </ListboxOption>
          <ListboxOption value="http">
            <ListboxLabel>http</ListboxLabel>
          </ListboxOption>
          <ListboxOption value="sse">
            <ListboxLabel>sse</ListboxLabel>
          </ListboxOption>
        </Listbox>
      </Field>

      <Field>
        <Label>Isolation Mode</Label>
        <Listbox
          name="isolation-mode"
          value={formData.isolation_mode}
          onChange={(value: string) =>
            onChange({ isolation_mode: value as 'shared' | 'per_user' })
          }
        >
          <ListboxOption value="shared">
            <ListboxLabel>shared</ListboxLabel>
          </ListboxOption>
          <ListboxOption value="per_user">
            <ListboxLabel>per_user</ListboxLabel>
          </ListboxOption>
        </Listbox>
      </Field>
    </>
  );
}
