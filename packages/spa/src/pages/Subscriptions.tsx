import { Heading } from '@/components/catalyst/heading';
import { Text } from '@/components/catalyst/text';
import { usePageTitle } from '@/hooks/usePageTitle';

export function Subscriptions() {
  usePageTitle('My Subscriptions');
  return (
    <div className="space-y-6">
      <Heading>My Subscriptions</Heading>
      <Text>View your active MCP subscriptions</Text>

      <div className="rounded-lg bg-white p-6 ring-1 ring-zinc-950/5">
        <h3 className="text-base/7 font-semibold text-zinc-900">Coming Soon</h3>
        <p className="mt-2 text-sm/6 text-zinc-500">
          Subscription management interface is under development. Manage your active subscriptions to MCP servers, view usage, billing details, and subscription history.
        </p>
      </div>
    </div>
  );
}
