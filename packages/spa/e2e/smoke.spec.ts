import { test, expect } from '@playwright/test';
import { login } from './helpers';

test.describe('Smoke Test', () => {
  test('login page loads', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator('#username')).toBeVisible();
    await expect(page.locator('#password')).toBeVisible();
  });

  test('admin can login', async ({ page }) => {
    await login(page);
    await expect(page).toHaveURL(/app\/dashboard/);
  });
});
