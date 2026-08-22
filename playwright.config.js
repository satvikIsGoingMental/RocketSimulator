import { defineConfig, devices } from '@playwright/test';

/* The simulator needs a real WebGL context, which headless Chromium only provides through its
   software rasterizer. Without these flags every test fails at "Could not start the 3D view".
   --headless=new is what actually supports WebGL; the old headless mode does not. */
const CHROMIUM_WEBGL_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--enable-webgl',
  '--ignore-gpu-blocklist',
];

export default defineConfig({
  testDir: './tests',
  // Full-flight tests fast-forward months of simulated time; they need room.
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  /* PW_JSON=1 swaps to a file-only reporter. The live "list" reporter writes straight to stdout,
     which throws EPIPE when the run is launched from a non-interactive shell with its output
     redirected — set PW_JSON=1 in scripts/CI wrappers and read test-results/results.json. */
  reporter: process.env.PW_JSON
    ? [['json', { outputFile: 'test-results/results.json' }], ['html', { open: 'never' }]]
    : process.env.CI
      ? [['github'], ['html', { open: 'never' }]]
      : [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        launchOptions: { args: CHROMIUM_WEBGL_ARGS },
      },
    },
  ],

  // ES modules will not load over file://, so every run goes through a real static server.
  webServer: {
    command: 'npx --yes http-server . -p 4173 -c-1 --silent',
    url: 'http://127.0.0.1:4173/index.html',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
