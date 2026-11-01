import { expect, test } from '@playwright/test';

test('search suggestions appear', { tag: '@flaky-demo' }, async ({ page }) => {
  await page.setContent(`
    <input aria-label="Search" />
    <ul id="suggestions"></ul>
    <script>
      document.querySelector('input').addEventListener('input', () => {
        setTimeout(() => { document.getElementById('suggestions').innerHTML = '<li>trail shoes</li>'; }, 1500);
      });
    </script>`);
  await page.getByLabel('Search').fill('trail');
  // The first attempt gives up too early, so the test passes only on retry.
  const timeout = test.info().retry === 0 ? 500 : 3_000;
  await expect(page.locator('#suggestions li')).toHaveText('trail shoes', { timeout });
});
