import { Page } from '@playwright/test';

export async function login(page: Page, username = 'admin', password = 'admin123') {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', password);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/app/dashboard');
}
