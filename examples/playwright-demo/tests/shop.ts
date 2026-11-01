import type { Page } from '@playwright/test';

/** A tiny self-contained storefront, so the demo needs no web server. */
export async function openShop(page: Page, options: { total?: string } = {}) {
  await page.setContent(`
    <style>
      body { font-family: system-ui, sans-serif; margin: 24px; }
      .product { border: 1px solid #ddd; border-radius: 8px; padding: 12px; margin: 8px 0; }
      button { padding: 6px 12px; }
    </style>
    <h1>KlovPlay Shop</h1>
    <section aria-label="Catalog">
      <div class="product"><h2>Trail Shoes</h2><p>$120.00</p><button data-price="120">Add to cart</button></div>
      <div class="product"><h2>Rain Jacket</h2><p>$80.00</p><button data-price="80">Add to cart</button></div>
    </section>
    <section aria-label="Cart">
      <p>Items: <span id="count">0</span></p>
      <p>Total: <strong id="total">${options.total ?? '$0.00'}</strong></p>
      <label>Discount code <input id="code" /></label>
      <button id="apply">Apply</button>
      <button id="pay">Pay now</button>
      <p id="status" role="status"></p>
    </section>
    <script>
      let total = 0;
      document.querySelectorAll('[data-price]').forEach((b) => b.addEventListener('click', () => {
        total += Number(b.dataset.price);
        document.getElementById('count').textContent = String(Number(document.getElementById('count').textContent) + 1);
        document.getElementById('total').textContent = '$' + total.toFixed(2);
      }));
      document.getElementById('apply').addEventListener('click', () => {
        if (document.getElementById('code').value === 'SAVE10') {
          total = total * 0.9;
          document.getElementById('total').textContent = '$' + total.toFixed(2);
          document.getElementById('status').textContent = 'Discount applied';
        }
      });
      document.getElementById('pay').addEventListener('click', () => {
        setTimeout(() => { document.getElementById('status').textContent = 'Payment declined'; }, 300);
      });
    </script>`);
}

/** Simulates a backend call that answers with a gateway error carrying volatile details. */
export function failingGatewayCall(resource: string): never {
  const port = 40000 + Math.floor(Math.random() * 20000);
  const requestId = crypto.randomUUID();
  throw new Error(`GET http://localhost:${port}/api/${resource} returned 502 Bad Gateway (request id ${requestId})`);
}
