/* Smooth cross-page navigation: internal link clicks fade the page out
 * before the browser navigates, and index.css fades every page in on load. */

const LEAVE_DURATION_MS = 240

export function initPageTransitions() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return

    const anchor = (event.target as Element | null)?.closest?.('a')
    if (!anchor) return
    if ((anchor.target && anchor.target !== '_self') || anchor.hasAttribute('download')) return

    const href = anchor.getAttribute('href')
    if (!href || href.startsWith('#')) return

    const url = new URL(anchor.href, window.location.href)
    if (url.origin !== window.location.origin) return
    /* In-page anchors (e.g. /#apply while on /) scroll instead of navigating. */
    if (url.pathname === window.location.pathname && url.hash) return

    event.preventDefault()
    document.documentElement.classList.add('nr-page-leaving')
    window.setTimeout(() => {
      window.location.href = anchor.href
    }, LEAVE_DURATION_MS)
  })

  /* Pages restored from the back-forward cache would otherwise stay faded out. */
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) document.documentElement.classList.remove('nr-page-leaving')
  })
}
