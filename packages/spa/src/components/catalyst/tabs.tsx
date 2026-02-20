import { Tab, TabGroup, TabList, TabPanel, TabPanels } from '@headlessui/react'
import clsx from 'clsx'
import type React from 'react'

export function Tabs({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof TabGroup>) {
  return (
    <TabGroup {...props} className={clsx(className)}>
      {children}
    </TabGroup>
  )
}

export function TabsList({ className, ...props }: React.ComponentPropsWithoutRef<typeof TabList>) {
  return (
    <TabList
      {...props}
      className={clsx(
        className,
        'flex gap-4 border-b border-zinc-950/10 dark:border-white/10'
      )}
    />
  )
}

export function TabsTrigger({ className, children, ...props }: React.ComponentPropsWithoutRef<typeof Tab>) {
  return (
    <Tab
      {...props}
      className={clsx(
        className,
        'border-b-2 border-transparent pb-2.5 text-sm/6 font-medium text-zinc-500 dark:text-zinc-400',
        'data-selected:border-teal-600 data-selected:text-zinc-950 dark:data-selected:border-teal-400 dark:data-selected:text-white',
        'hover:text-zinc-700 dark:hover:text-zinc-300',
        'focus:outline-none data-focus:outline-2 data-focus:outline-offset-2 data-focus:outline-teal-600'
      )}
    >
      {children}
    </Tab>
  )
}

export function TabsContent({ className, ...props }: React.ComponentPropsWithoutRef<typeof TabPanel>) {
  return (
    <TabPanel
      {...props}
      className={clsx(className, 'mt-4')}
    />
  )
}

// Wrapper for TabPanels (required by Headless UI)
export function TabsPanels({ className, ...props }: React.ComponentPropsWithoutRef<typeof TabPanels>) {
  return <TabPanels {...props} className={clsx(className)} />
}
