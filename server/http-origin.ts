type TrustedRequestOriginInput = {
  canonicalOrigin: string
  fetchSite?: string
  origin?: string
  requestOrigin: string
}

function normalizedOrigin(value: string) {
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

function trustedFirstPartyOrigins(canonicalOrigin: string) {
  const normalizedCanonicalOrigin = normalizedOrigin(canonicalOrigin)
  if (!normalizedCanonicalOrigin) return new Set<string>()

  const canonicalUrl = new URL(normalizedCanonicalOrigin)
  const alternateUrl = new URL(normalizedCanonicalOrigin)
  alternateUrl.hostname = canonicalUrl.hostname.startsWith('www.')
    ? canonicalUrl.hostname.slice(4)
    : `www.${canonicalUrl.hostname}`

  return new Set([canonicalUrl.origin, alternateUrl.origin])
}

export function hasTrustedRequestOrigin({
  canonicalOrigin,
  fetchSite,
  origin,
  requestOrigin,
}: TrustedRequestOriginInput) {
  if (fetchSite === 'cross-site') return false
  const trustedOrigins = trustedFirstPartyOrigins(canonicalOrigin)
  const normalizedRequestOrigin = normalizedOrigin(requestOrigin)
  if (!normalizedRequestOrigin || !trustedOrigins.has(normalizedRequestOrigin)) return false
  if (!origin) return true
  const normalizedHeaderOrigin = normalizedOrigin(origin)
  return normalizedHeaderOrigin !== null && trustedOrigins.has(normalizedHeaderOrigin)
}
