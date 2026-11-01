import { defineConfig, devices } from '@playwright/test';

/**
 * Demo suite for KlovPlay. Start the stack (`docker compose up -d`), create a project,
 * then run with:
 *
 *   KLOVPLAY_API_KEY=kp_... pnpm demo
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  workers: 4,
  retries: 1,
  timeout: 15_000,
  reporter: [
    ['list'],
    [
      '@klovplay/playwright-reporter',
      {
        serverUrl: process.env.KLOVPLAY_SERVER_URL ?? 'http://localhost:8080',
        project: process.env.KLOVPLAY_PROJECT ?? 'demo',
        stepMode: 'all-api',
      },
    ],
  ],
  use: {
    trace: 'on',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // Lets the demo run against a preinstalled Chromium build.
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {},
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chrome', use: { ...devices['Pixel 7'] } },
  ],
});
