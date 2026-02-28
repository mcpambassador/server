import { useEffect } from 'react';

export function usePageTitle(title: string) {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = title ? `${title} | MCP Ambassador` : 'MCP Ambassador';

    return () => {
      document.title = previousTitle;
    };
  }, [title]);
}
