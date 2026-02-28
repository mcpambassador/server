import { RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { ErrorBoundary } from '@/components/shared/ErrorBoundary';
import { GlobalErrorHandler } from '@/components/shared/GlobalErrorHandler';
import { router } from './router';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      retry: 1,
    },
  },
});

function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <GlobalErrorHandler>
          <RouterProvider router={router} />
        </GlobalErrorHandler>
        <Toaster
          position="top-right"
          toastOptions={{
            classNames: {
              toast: 'bg-white dark:bg-zinc-900 ring-1 ring-zinc-950/10 dark:ring-white/10 shadow-lg rounded-lg',
              title: 'text-zinc-950 dark:text-white text-sm font-medium',
              description: 'text-zinc-500 dark:text-zinc-400 text-sm',
            },
          }}
        />
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
