import { Link } from 'react-router-dom';
import { ChevronRightIcon } from '@heroicons/react/20/solid';

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

export interface BreadcrumbProps {
  items: BreadcrumbItem[];
}

export function Breadcrumb({ items }: BreadcrumbProps) {
  return (
    <nav className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
      {items.map((item, index) => {
        const isLast = index === items.length - 1;
        
        return (
          <div key={index} className="flex items-center gap-2">
            {item.href && !isLast ? (
              <Link
                to={item.href}
                className="hover:text-zinc-900 dark:hover:text-white transition-colors"
              >
                {item.label}
              </Link>
            ) : (
              <span className={isLast ? 'font-medium text-zinc-900 dark:text-white' : ''}>
                {item.label}
              </span>
            )}
            {!isLast && (
              <ChevronRightIcon className="size-4 text-zinc-400 dark:text-zinc-500" />
            )}
          </div>
        );
      })}
    </nav>
  );
}
