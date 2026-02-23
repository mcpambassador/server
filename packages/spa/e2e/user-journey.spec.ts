import { test, expect } from '@playwright/test';
import { login } from './helpers';

test.describe('User Journey E2E', () => {
  test('Admin login → Dashboard → Client lifecycle → Marketplace → Logout', async ({ page }) => {
    // 1. Admin logs in
    await login(page);
    await expect(page).toHaveURL(/app\/dashboard/);

    // 2. Dashboard loads with stats
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    // Note: 'My Clients' and 'MCPs Available' are stat labels (dt elements), not headings
    await expect(page.locator('dt:has-text("My Clients")')).toBeVisible();
    await expect(page.locator('dt:has-text("MCPs Available")')).toBeVisible();

    // 3. Navigate to My Clients
    await page.locator('nav').getByRole('link', { name: 'My Clients' }).click();
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
    await page.locator('nav').getByRole('link', { name: 'Marketplace' }).click();
    await expect(page).toHaveURL(/app\/marketplace/);
    await expect(page.getByRole('heading', { name: 'Marketplace' })).toBeVisible();

    // 7. Browse available MCPs (handle empty state in CI)
    const emptyState = page.locator('text=No MCPs');
    const hasMcps = await emptyState.count().then(c => c === 0);
    
    if (hasMcps) {
      // 8. Click on an MCP for details
      const viewDetails = page.getByRole('link', { name: 'View Details' }).first();
      await expect(viewDetails).toBeVisible();
      await viewDetails.click();
      await expect(page).toHaveURL(/app\/marketplace\/[^/]+/);
      await expect(page.locator('h1')).toBeVisible();
    } else {
      // In CI, marketplace may be empty - that's okay
      await expect(page.locator('text=No MCPs')).toBeVisible();
    }

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
