import { defineConfig } from '@playwright/test';
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3000';
export default defineConfig({ testDir: './tests/ui', timeout: 30000, expect: { timeout: 10000 }, fullyParallel: false, workers: 1,
  use: { baseURL, viewport: { width: 1440, height: 1080 }, trace: 'retain-on-failure' },
  webServer: { command: 'npm run dev', url: baseURL, reuseExistingServer: true, timeout: 120000,
    env: { ...process.env, ADMIN_HEALTH_ENABLED: 'true', ADMIN_HEALTH_USERNAME: 'health-test', ADMIN_HEALTH_PASSWORD: 'health-test-password', MARKET_MONITORING_ENABLED: 'true' },
    gracefulShutdown: { signal: 'SIGINT', timeout: 1000 } }, reporter: 'list',
});
