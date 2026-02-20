import clsx from 'clsx'
import type React from 'react'

export function Card({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return (
    <div
      {...props}
      className={clsx(
        className,
        'rounded-xl bg-white p-6 shadow-sm ring-1 ring-zinc-950/5 dark:bg-zinc-900 dark:ring-white/10'
      )}
    />
  )
}

export function CardHeader({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return (
    <div
      {...props}
      className={clsx(className, 'flex flex-col space-y-1.5')}
    />
  )
}

export function CardTitle({ className, ...props }: React.ComponentPropsWithoutRef<'h3'>) {
  return (
    <h3
      {...props}
      className={clsx(className, 'text-base/7 font-semibold text-zinc-950 dark:text-white')}
    />
  )
}

export function CardDescription({ className, ...props }: React.ComponentPropsWithoutRef<'p'>) {
  return (
    <p
      {...props}
      className={clsx(className, 'text-sm/6 text-zinc-500 dark:text-zinc-400')}
    />
  )
}

export function CardContent({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return <div {...props} className={clsx(className, 'pt-4')} />
}

export function CardFooter({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return (
    <div
      {...props}
      className={clsx(className, 'flex items-center pt-4')}
    />
  )
}
