import * as Headless from '@headlessui/react'
import React, { forwardRef } from 'react'
import { Link as RouterLink } from 'react-router-dom'

export const Link = forwardRef(function Link(
  { href, to, ...props }: { href?: string; to?: string } & Omit<React.ComponentPropsWithoutRef<'a'>, 'href'>,
  ref: React.ForwardedRef<HTMLAnchorElement>
) {
  const destination = to ?? href ?? '#'

  // External links or hash links use a plain <a> tag
  if (destination.startsWith('http') || destination.startsWith('mailto:') || destination === '#') {
    return (
      <Headless.DataInteractive>
        <a href={destination} {...props} ref={ref} />
      </Headless.DataInteractive>
    )
  }

  // Internal links use react-router-dom
  return (
    <Headless.DataInteractive>
      <RouterLink to={destination} {...props} ref={ref} />
    </Headless.DataInteractive>
  )
})
