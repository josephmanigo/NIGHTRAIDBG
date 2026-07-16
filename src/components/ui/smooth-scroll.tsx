// smooth-scroll.tsx
// Stacked sticky section wrapper — each child stacks on top of the previous
// one as you scroll, creating a "card rise" effect.
// Note: ReactLenis root is NOT used here because the app already runs a
// global Lenis instance via useSmoothScroll(). Using ReactLenis root again
// would create a second conflicting instance.

import React, { forwardRef } from 'react'

interface SmoothScrollStackProps {
  children?: React.ReactNode
  className?: string
}

const SmoothScrollStack = forwardRef<HTMLDivElement, SmoothScrollStackProps>(
  ({ children, className = '' }, ref) => {
    return (
      <div ref={ref} className={className}>
        {children}
      </div>
    )
  },
)

SmoothScrollStack.displayName = 'SmoothScrollStack'

export default SmoothScrollStack
