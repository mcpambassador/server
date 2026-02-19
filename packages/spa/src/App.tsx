import { RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components/ui/toast';
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
          <ToastProvider>
            <RouterProvider router={router} />
          </ToastProvider>
        </GlobalErrorHandler>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
