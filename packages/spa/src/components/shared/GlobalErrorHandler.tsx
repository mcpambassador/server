import * as React from 'react';
import { useToast } from '@/components/ui/toast';

interface Props {
  children: React.ReactNode;
}

export function GlobalErrorHandler({ children }: Props) {
  const { addToast } = useToast();

  React.useEffect(() => {
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      console.error('Unhandled promise rejection:', event.reason);
      
      // Extract useful error message
      const message = event.reason?.message || event.reason?.toString() || 'An unexpected error occurred';
      
      addToast({
        variant: 'destructive',
        title: 'Error',
        description: message,
      });
    };

    const handleError = (event: ErrorEvent) => {
      console.error('Unhandled error:', event.error);
      
      addToast({
        variant: 'destructive',
        title: 'Error',
        description: event.message || 'An unexpected error occurred',
      });
    };

    window.addEventListener('unhandledrejection', handleUnhandledRejection);
    window.addEventListener('error', handleError);

    return () => {
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
      window.removeEventListener('error', handleError);
    };
  }, [addToast]);

  return <>{children}</>;
}
