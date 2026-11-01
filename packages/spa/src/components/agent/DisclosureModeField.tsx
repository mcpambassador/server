import { Field, Label, Description } from '@/components/catalyst/fieldset';
import { Select } from '@/components/catalyst/select';
import {
  DISCLOSURE_MODE_OPTIONS,
  DISCLOSURE_MODE_HELP,
  type DisclosureMode,
} from '@/api/agent-types';

/** ADR-022: how the agent's tool list is presented. Same permissions in both modes. */
export function DisclosureModeField({
  value,
  onChange,
}: {
  value: DisclosureMode;
  onChange: (mode: DisclosureMode) => void;
}) {
  return (
    <Field>
      <Label>Tool list</Label>
      <Description>{DISCLOSURE_MODE_HELP}</Description>
      <Select
        name="disclosure_mode"
        value={value}
        onChange={e => onChange(e.target.value as DisclosureMode)}
      >
        {DISCLOSURE_MODE_OPTIONS.map(o => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    </Field>
  );
}
