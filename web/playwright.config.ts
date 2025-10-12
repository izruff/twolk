import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  timeout: 240_000,
  webServer: [
    {
      command: 'npm run start',
      cwd: '../backend/webrtc',
      url: 'https://localhost:3000/socket.io/?EIO=4&transport=polling',
      reuseExistingServer: true,
      ignoreHTTPSErrors: true,
      timeout: 60_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: 'npm run dev',
      cwd: '.',
      url: 'http://localhost:5173',
      reuseExistingServer: true,
      timeout: 60_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
  use: {
    baseURL: 'http://localhost:5173',
    ignoreHTTPSErrors: true,
    headless: true,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ignoreHTTPSErrors: true,
        launchOptions: {
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
            '--ignore-certificate-errors',
            '--disable-web-security',
          ],
        },
        permissions: ['microphone'],
      },
    },
  ],
});
