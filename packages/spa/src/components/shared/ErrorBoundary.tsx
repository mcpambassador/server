import * as React from 'react';
import { Button } from '@/components/catalyst/button';
import { AlertTriangle } from 'lucide-react';

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-zinc-50 p-4">
          <div className="max-w-md rounded-lg bg-white p-6 ring-1 ring-zinc-950/5">
            <div className="flex items-center gap-3">
              <AlertTriangle className="h-8 w-8 text-red-600" />
              <div>
                <h3 className="text-base/7 font-semibold text-zinc-900">Something went wrong</h3>
                <p className="text-sm/6 text-zinc-500">An unexpected error occurred</p>
              </div>
            </div>
            <div className="mt-4 space-y-4">
              {this.state.error && (
                <div className="rounded-lg bg-zinc-50 p-3">
                  <p className="text-sm font-mono text-zinc-500">
                    {this.state.error.message}
                  </p>
                </div>
              )}
              <Button onClick={this.handleReset} className="w-full">
                Try Again
              </Button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
