import { test } from '@playwright/test';

test.describe('Reports', () => {
  test('exports a report to PDF', async ({ page }) => {
    test.skip(true, 'PDF export is not available in this environment');
    await page.goto('about:blank');
  });

  test('generates the yearly report', async ({ page }) => {
    test.setTimeout(3_000);
    await page.setContent('<h1>Generating…</h1>');
    await test.step('wait for the report', async () => {
      await page.waitForTimeout(6_000);
    });
  });
});
