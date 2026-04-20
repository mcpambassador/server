import type React from 'react';
import clsx from 'clsx';

/**
 * Card — shared surface component used throughout the SPA.
 *
 * Encapsulates the recurring class string:
 *   rounded-lg bg-white dark:bg-white/5 ring-1 ring-zinc-950/10 dark:ring-white/10
 *
 * Slots:
 *   <Card>          — outer container
 *   <CardHeader>    — top section, typically contains a title + optional action
 *   <CardBody>      — padded content area
 */

interface CardProps {
  className?: string;
  children: React.ReactNode;
}

export function Card({ className, children }: CardProps) {
  return (
    <div
      className={clsx(
        'rounded-lg bg-white dark:bg-white/5 ring-1 ring-zinc-950/10 dark:ring-white/10',
        className
      )}
    >
      {children}
    </div>
  );
}

interface CardHeaderProps {
  className?: string;
  children: React.ReactNode;
}

export function CardHeader({ className, children }: CardHeaderProps) {
  return (
    <div
      className={clsx(
        'px-4 py-5 sm:p-6 border-b border-zinc-950/5 dark:border-white/10',
        className
      )}
    >
      {children}
    </div>
  );
}

interface CardBodyProps {
  className?: string;
  children: React.ReactNode;
}

export function CardBody({ className, children }: CardBodyProps) {
  return (
    <div className={clsx('px-4 py-5 sm:p-6', className)}>
      {children}
    </div>
  );
}
