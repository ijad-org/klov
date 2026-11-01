import { epic, feature, issue, severity } from '@klovplay/playwright-reporter/annotations';
import { expect, test } from '@playwright/test';

import { openShop } from './shop';

test.describe('Checkout', () => {
  test('pays with a saved card', { annotation: [severity('blocker'), epic('Checkout'), feature('Payments')] }, async ({ page }) => {
    // Labels can also be added while the test runs.
    test.info().annotations.push(issue('SHOP-42'));
    await openShop(page);
    await test.step('fill the cart', async () => {
      await page.getByRole('button', { name: 'Add to cart' }).first().click();
    });
    await test.step('pay', async () => {
      await page.getByRole('button', { name: 'Pay now' }).click();
      await page.waitForTimeout(600);
      await expect(page.getByRole('status')).toHaveText('Payment accepted', { timeout: 2_000 });
    });
  });

  test('applies a discount code', { annotation: [severity('normal'), epic('Checkout'), feature('Promotions')] }, async ({ page }) => {
    await openShop(page);
    await page.getByRole('button', { name: 'Add to cart' }).first().click();
    await page.getByLabel('Discount code').fill('SAVE10');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByRole('status')).toHaveText('Discount applied');
    await expect(page.locator('#total')).toHaveText('$108.00');
    await page.waitForTimeout(700);
  });

  test('known bug: coupons stack', { annotation: [{ type: 'issue', description: 'SHOP-77' }] }, async ({ page }) => {
    // Documented bug: the test is expected to fail until SHOP-77 is fixed.
    test.fail();
    await openShop(page);
    await page.getByRole('button', { name: 'Add to cart' }).first().click();
    await page.getByLabel('Discount code').fill('SAVE10');
    await page.getByRole('button', { name: 'Apply' }).click();
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.locator('#total')).toHaveText('$108.00');
  });
});
