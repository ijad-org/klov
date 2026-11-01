import { epic, feature, owner, severity } from '@klovplay/playwright-reporter/annotations';
import { expect, test } from '@playwright/test';

import { openShop } from './shop';

test.describe('Storefront', () => {
  test(
    'shows the product catalog',
    { tag: ['@smoke', '@feature:Catalog'], annotation: [severity('critical'), epic('Storefront'), owner('web-team')] },
    async ({ page }) => {
      await openShop(page);
      await expect(page.getByRole('heading', { name: 'KlovPlay Shop' })).toBeVisible();
      await expect(page.locator('.product')).toHaveCount(2);
      await page.waitForTimeout(800);
    },
  );

  test('adds items to the cart', { annotation: [severity('normal'), epic('Storefront'), feature('Cart')] }, async ({ page }) => {
    await openShop(page);
    await test.step('add trail shoes', async () => {
      await page.getByRole('button', { name: 'Add to cart' }).first().click();
      await page.waitForTimeout(500);
    });
    await test.step('add rain jacket', async () => {
      await page.getByRole('button', { name: 'Add to cart' }).nth(1).click();
      await page.waitForTimeout(500);
    });
    await test.step('check the cart', async () => {
      await expect(page.locator('#count')).toHaveText('2');
      await expect(page.locator('#total')).toHaveText('$200.00');
    });
  });
});
