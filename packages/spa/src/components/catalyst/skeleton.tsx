import clsx from 'clsx'
import type React from 'react'

export function Skeleton({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return (
    <div
      {...props}
      className={clsx(
        className,
        'animate-pulse rounded-md bg-zinc-100 dark:bg-zinc-800'
      )}
    />
  )
}
