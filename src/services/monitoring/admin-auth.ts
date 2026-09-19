import 'server-only';
import { createHash, timingSafeEqual } from 'node:crypto';

export const ADMIN_HEALTH_SECURITY_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
} as const;

export function isAdminHealthEnabled() {
  return process.env.ADMIN_HEALTH_ENABLED === 'true'
    && Boolean(process.env.ADMIN_HEALTH_USERNAME)
    && Boolean(process.env.ADMIN_HEALTH_PASSWORD);
}

function digest(value: string) { return createHash('sha256').update(value, 'utf8').digest(); }
function safeEqual(left: string, right: string) { return timingSafeEqual(digest(left), digest(right)); }

export function isAdminHealthAuthorized(authorization: string | null) {
  if (!isAdminHealthEnabled() || !authorization?.startsWith('Basic ')) return false;
  try {
    const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator < 0) return false;
    return safeEqual(decoded.slice(0, separator), process.env.ADMIN_HEALTH_USERNAME!)
      && safeEqual(decoded.slice(separator + 1), process.env.ADMIN_HEALTH_PASSWORD!);
  } catch {
    return false;
  }
}

export function adminHealthUnauthorizedResponse() {
  return new Response('Authentication required.', {
    status: 401,
    headers: { ...ADMIN_HEALTH_SECURITY_HEADERS, 'WWW-Authenticate': 'Basic realm="PositionLayer health", charset="UTF-8"' },
  });
}
