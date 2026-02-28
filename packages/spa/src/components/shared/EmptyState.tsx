import { ReactNode } from 'react';
import { Text } from '@/components/catalyst/text';
import { Button } from '@/components/catalyst/button';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: {
    label: string;
    onClick?: () => void;
    href?: string;
  };
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-12 px-4">
      {icon && (
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800 mb-4">
          {icon}
        </div>
      )}
      <Text className="text-center font-medium text-zinc-900 dark:text-white">
        {title}
      </Text>
      {description && (
        <Text className="mt-1 text-center text-sm text-zinc-500 dark:text-zinc-400">
          {description}
        </Text>
      )}
      {action && (
        <div className="mt-6">
          {action.href ? (
            <Button href={action.href}>{action.label}</Button>
          ) : (
            <Button onClick={action.onClick}>{action.label}</Button>
          )}
        </div>
      )}
    </div>
  );
}
