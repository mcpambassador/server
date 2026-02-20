import { test, expect } from '@playwright/test';
import { login } from './helpers';

test.describe('User Journey E2E', () => {
  test('Admin login → Dashboard → Client lifecycle → Marketplace → Logout', async ({ page }) => {
    // 1. Admin logs in
    await login(page);
    await expect(page).toHaveURL(/app\/dashboard/);

    // 2. Dashboard loads with stats
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'My Clients' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'MCPs Available' })).toBeVisible();

    // 3. Navigate to My Clients
    await page.locator('aside').getByRole('link', { name: 'My Clients' }).click();
    await expect(page).toHaveURL(/app\/clients/);
    await expect(page.getByRole('heading', { name: 'My Clients' })).toBeVisible();

    // 4. Create a new client
    const clientName = `e2e-client-${Math.floor(Math.random() * 100000)}`;
    await page.getByRole('button', { name: /Create Client/i }).click();
    await expect(page.getByText('Create New Client')).toBeVisible();
    await page.fill('#client_name', clientName);
    await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();

    // 5. Verify client appears in list (and dismiss API key dialog)
    await expect(page.getByText('API Key Created')).toBeVisible();
    await page.getByRole('button', { name: "I've Saved the Key" }).click();
    await expect(page.getByText(clientName)).toBeVisible();

    // 6. Navigate to Marketplace
    await page.locator('aside').getByRole('link', { name: 'Marketplace' }).click();
    await expect(page).toHaveURL(/app\/marketplace/);
    await expect(page.getByRole('heading', { name: 'Marketplace' })).toBeVisible();

    // 7. Browse available MCPs (ensure at least one exists)
    const viewDetails = page.getByRole('link', { name: 'View Details' }).first();
    await expect(viewDetails).toBeVisible();

    // 8. Click on an MCP for details
    await viewDetails.click();
    await expect(page).toHaveURL(/app\/marketplace\/[^/]+/);
    await expect(page.locator('h1')).toBeVisible();

    // 9. Go back to client detail
    await page.goto('/app/clients');
    await expect(page).toHaveURL(/app\/clients/);
    await page.getByText(clientName).click();
    await expect(page).toHaveURL(/app\/clients\/[^/]+/);
    await expect(page.locator('h1', { hasText: clientName })).toBeVisible();

    // 10. Logout
    await page.locator('header').getByRole('button').last().click();
    await page.getByRole('menuitem', { name: 'Log out' }).click();
    await expect(page).toHaveURL(/login/, { timeout: 10000 });
  });
});
