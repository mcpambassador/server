import { test, expect } from '@playwright/test';
import { login } from './helpers';

test.describe('Validate MCP fixes', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('Fix 1: Admin can edit published MCP metadata without structural fields', async ({ page }) => {
    await page.goto('/app/admin/mcps');
    // find an MCP named Firecrawl (common test MCP)
    const mcpLink = page.getByText('Firecrawl').first();
    await expect(mcpLink).toBeVisible({ timeout: 10000 });
    await mcpLink.click();
    await expect(page.locator('h1')).toBeVisible();

    // open Edit
    const editBtn = page.getByRole('button', { name: 'Edit' }).first();
    await expect(editBtn).toBeVisible({ timeout: 5000 });

    // open Edit, then fill and save; intercept the PATCH on save
    await editBtn.click();
    const newDesc = `Updated via Playwright test ${Date.now()}`;
    await page.fill('textarea#description, textarea[name="description"]', newDesc).catch(() => {});
    const saveBtn = page.getByRole('button', { name: 'Save' }).first();

    const [req] = await Promise.all([
      page.waitForRequest(r => r.method() === 'PATCH' && /\/v1\/admin\/mcps\//.test(r.url()), { timeout: 20000 }),
      saveBtn.click(),
    ]);
    const postData = req.postData() || '';
    // Assert structural field not present
    expect(postData.includes('requires_user_credentials')).toBeFalsy();

    // verify description updated in UI
    await expect(page.locator(`text=${newDesc}`)).toBeVisible({ timeout: 10000 });
    await page.screenshot({ path: 'fix1-edit-published.png', fullPage: true });
  });

  test('Fix 2: Admin can delete archived MCPs', async ({ page }) => {
    await page.goto('/app/admin/mcps');
    // Create a test MCP via the admin API using the logged-in session
    const unique = `playwright-delete-${Date.now()}`;
    const createResp = await page.evaluate(async (uniqueName) => {
      const body = {
        name: uniqueName,
        display_name: 'Playwright Delete Test',
        transport_type: 'stdio',
        endpoint: 'test-command',
        config: { command: ['echo','ok'], env: {} }
      };
      const r = await fetch('/v1/admin/mcps', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, json: await r.text() };
    }, unique);
    // navigate back to list and locate the created MCP
    await page.reload();
    const created = page.getByText('Playwright Delete Test').first();
    await expect(created).toBeVisible({ timeout: 10000 });
    await created.click();

    // Publish then Archive via UI buttons if present
    const publishBtn = page.getByRole('button', { name: 'Publish' }).first();
    if (await publishBtn.isVisible().catch(() => false)) {
      await publishBtn.click().catch(() => {});
    }
    const archiveBtn = page.getByRole('button', { name: 'Archive' }).first();
    if (await archiveBtn.isVisible().catch(() => false)) {
      await archiveBtn.click().catch(() => {});
      // confirm archive dialog
      const confirm = page.getByRole('button', { name: 'Confirm' }).first();
      if (await confirm.isVisible().catch(() => false)) await confirm.click();
    }

    // Verify Delete button appears
    const deleteBtn = page.getByRole('button', { name: 'Delete' }).first();
    await expect(deleteBtn).toBeVisible({ timeout: 10000 });
    await deleteBtn.click();
    // confirm deletion
    const confirmDel = page.getByRole('button', { name: /Delete|Confirm/ }).last();
    if (await confirmDel.isVisible().catch(() => false)) await confirmDel.click();

    // verify removed from list
    await page.goto('/app/admin/mcps');
    await expect(page.getByText('Playwright Delete Test')).toHaveCount(0);
    await page.screenshot({ path: 'fix2-delete-archived.png', fullPage: true });
  });

  test('Fix 3: User credential fields display in subscribe dialog', async ({ page, context }) => {
    // Logout admin and go to user marketplace
    await page.goto('/app/marketplace');
    // if redirected to login, try register/login flow
    if (page.url().includes('/login')) {
      // quick register flow if available
      const email = `e2e_user_${Date.now()}@example.com`;
      if (await page.getByRole('link', { name: 'Register' }).isVisible().catch(() => false)) {
        await page.getByRole('link', { name: 'Register' }).click().catch(() => {});
        await page.fill('#email', email).catch(() => {});
        await page.fill('#password', 'Password123!').catch(() => {});
        await page.getByRole('button', { name: 'Sign up' }).click().catch(() => {});
        await page.waitForURL('**/app/marketplace');
      } else {
        // try login with a test user
        await page.goto('/login');
        await page.fill('#username', 'user@example.com').catch(() => {});
        await page.fill('#password', 'Password123!').catch(() => {});
        await page.getByRole('button', { name: /Sign in|Log in|Login/ }).click().catch(() => {});
        await page.waitForURL('**/app/marketplace');
      }
    }

    // find Firecrawl in marketplace
    const mcpCard = page.getByText('Firecrawl').first();
    await expect(mcpCard).toBeVisible({ timeout: 10000 });
    await mcpCard.click();

    // Click Subscribe
    const subscribe = page.getByRole('button', { name: /Subscribe/i }).first();
    await expect(subscribe).toBeVisible({ timeout: 5000 });
    await subscribe.click();

    // Verify credential input appears (API Key)
    const apiKeyField = page.getByLabel('API Key').first();
    await expect(apiKeyField).toBeVisible({ timeout: 10000 });
    await page.screenshot({ path: 'fix3-subscribe-credentials.png', fullPage: true });
  });
});
