import { epic, owner } from '@klovplay/playwright-reporter/annotations';
import { test } from '@playwright/test';

import { failingGatewayCall } from './shop';

// Both tests fail with the same root cause (a 502 from the gateway) but different
// ports and request ids, so KlovPlay groups them into one failure cluster.
test.describe('Orders API', { annotation: [epic('Orders'), owner('api-team')] }, () => {
  test('lists recent orders', async ({ page }) => {
    await page.setContent('<h1>Orders</h1>');
    await page.waitForTimeout(400);
    failingGatewayCall('orders');
  });

  test('loads order history', async ({ page }) => {
    await page.setContent('<h1>History</h1>');
    await page.waitForTimeout(900);
    failingGatewayCall('orders');
  });
});
