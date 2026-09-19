import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { ADMIN_HEALTH_SECURITY_HEADERS, adminHealthUnauthorizedResponse, isAdminHealthAuthorized, isAdminHealthEnabled } from '@/services/monitoring/admin-auth';

export function proxy(request: NextRequest) {
  if (!isAdminHealthEnabled()) return new Response('Not found.', { status: 404, headers: ADMIN_HEALTH_SECURITY_HEADERS });
  if (!isAdminHealthAuthorized(request.headers.get('authorization'))) return adminHealthUnauthorizedResponse();
  const response = NextResponse.next();
  for (const [name, value] of Object.entries(ADMIN_HEALTH_SECURITY_HEADERS)) response.headers.set(name, value);
  return response;
}

export const config = { matcher: ['/admin/health/:path*', '/api/admin/health/:path*'] };
