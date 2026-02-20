import clsx from 'clsx'
import type React from 'react'

const colors = {
  info: 'bg-blue-50 text-blue-900 ring-blue-200 dark:bg-blue-950/50 dark:text-blue-200 dark:ring-blue-800',
  success: 'bg-emerald-50 text-emerald-900 ring-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-200 dark:ring-emerald-800',
  warning: 'bg-amber-50 text-amber-900 ring-amber-200 dark:bg-amber-950/50 dark:text-amber-200 dark:ring-amber-800',
  error: 'bg-red-50 text-red-900 ring-red-200 dark:bg-red-950/50 dark:text-red-200 dark:ring-red-800',
}

export function InlineAlert({
  color = 'info',
  className,
  children,
  ...props
}: { color?: keyof typeof colors } & React.ComponentPropsWithoutRef<'div'>) {
  return (
    <div
      {...props}
      className={clsx(className, 'rounded-lg p-4 ring-1 ring-inset text-sm/6', colors[color])}
    >
      {children}
    </div>
  )
}

export function InlineAlertTitle({ className, ...props }: React.ComponentPropsWithoutRef<'p'>) {
  return <p {...props} className={clsx(className, 'font-medium')} />
}

export function InlineAlertDescription({ className, ...props }: React.ComponentPropsWithoutRef<'p'>) {
  return <p {...props} className={clsx(className, 'mt-1')} />
}
