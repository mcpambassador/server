import { test, expect } from '@playwright/test';
import { login } from './helpers';

test.describe('Smoke Test', () => {
  test('login page loads', async ({ page }) => {
    await page.goto('/login');
    // Catalyst Input uses <Label> + <Input> without id attrs
    await expect(page.getByLabel('Username')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();
  });

  test('admin can login', async ({ page }) => {
    await login(page);
    await expect(page).toHaveURL(/app\/dashboard/);
  });
});
