import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import type { Role } from '../api/types'

/** Cosmetic gate ONLY -- hides a route from the nav/UI for the wrong role. This provides ZERO
 * real security by itself; every actual enforcement point is the require_role() decorator on the
 * Flask side. A viewer who guesses the /admin URL gets redirected here, but even if this
 * component were buggy or bypassed, the backend still 403s every admin-only API call. */
export function RequireRole({
  role,
  allow,
  children,
}: {
  role: Role
  allow: Role[]
  children: ReactNode
}) {
  if (!allow.includes(role)) {
    return <Navigate to={role ? '/status' : '/login'} replace />
  }
  return <>{children}</>
}
