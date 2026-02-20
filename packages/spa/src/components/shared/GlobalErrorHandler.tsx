import * as React from 'react';
import { toast } from 'sonner';

interface Props {
  children: React.ReactNode;
}

export function GlobalErrorHandler({ children }: Props) {

  React.useEffect(() => {
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      console.error('Unhandled promise rejection:', event.reason);
      
      // Extract useful error message
      const message = event.reason?.message || event.reason?.toString() || 'An unexpected error occurred';
      
      toast.error('Error', {
        description: message,
      });
    };

    const handleError = (event: ErrorEvent) => {
      console.error('Unhandled error:', event.error);
      
      toast.error('Error', {
        description: event.message || 'An unexpected error occurred',
      });
    };

    window.addEventListener('unhandledrejection', handleUnhandledRejection);
    window.addEventListener('error', handleError);

    return () => {
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
      window.removeEventListener('error', handleError);
    };
  }, []);

  return <>{children}</>;
}
