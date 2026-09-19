import { isAdminHealthAuthorized, isAdminHealthEnabled, ADMIN_HEALTH_SECURITY_HEADERS, adminHealthUnauthorizedResponse } from '@/services/monitoring/admin-auth';
import { readMonitoringSnapshot } from '@/services/monitoring/snapshot';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  if (!isAdminHealthEnabled()) return new Response('Not found.', { status: 404, headers: ADMIN_HEALTH_SECURITY_HEADERS });
  if (!isAdminHealthAuthorized(request.headers.get('authorization'))) return adminHealthUnauthorizedResponse();
  return Response.json(readMonitoringSnapshot(), { headers: ADMIN_HEALTH_SECURITY_HEADERS });
}
