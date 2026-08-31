type TrustedRequestOriginInput = {
  canonicalOrigin: string
  fetchSite?: string
  origin?: string
  requestOrigin: string
}

export function hasTrustedRequestOrigin({
  canonicalOrigin,
  fetchSite,
  origin,
  requestOrigin,
}: TrustedRequestOriginInput) {
  if (fetchSite === 'cross-site') return false
  if (!origin) return true
  return origin === canonicalOrigin || origin === requestOrigin
}
