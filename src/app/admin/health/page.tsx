import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { isAdminHealthAuthorized, isAdminHealthEnabled } from '@/services/monitoring/admin-auth';
import { readMonitoringSnapshot } from '@/services/monitoring/snapshot';
import { HealthDashboard } from './HealthDashboard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Market engine health · PositionLayer', robots: { index: false, follow: false } };

export default async function AdminHealthPage() {
  if (!isAdminHealthEnabled()) notFound();
  const requestHeaders = await headers();
  if (!isAdminHealthAuthorized(requestHeaders.get('authorization'))) notFound();
  return <HealthDashboard initial={readMonitoringSnapshot()} />;
}
