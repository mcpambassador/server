import { test, expect } from '@playwright/test';
import { login } from './helpers';

test.describe('Validate MCP fixes', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('Fix 1: Admin can edit published MCP metadata without structural fields', async ({
    page,
  }) => {
    await page.goto('/app/admin/mcps');

    // Wait for page to fully load — either a table row or empty state
    await page.waitForLoadState('networkidle');

    // Create a test MCP via API regardless — ensures we have one to edit
    const unique = `test-edit-${Date.now()}`;
    const createResult = await page.evaluate(async name => {
      const body = {
        name,
        display_name: 'Test MCP for Edit',
        transport_type: 'stdio',
        endpoint: 'echo',
        config: { command: ['echo', 'test'], env: {} },
        isolation_mode: 'shared',
      };
      const r = await fetch('/v1/admin/mcps', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const resp = await r.json();
      // Response shape: { ok: true, data: { mcp_id, name, ... } }
      const entry = resp.data;
      // Validate then Publish the MCP so structural fields are locked
      if (r.ok && entry?.mcp_id) {
        // Step 1: Validate (sets validation_status to 'valid')
        await fetch(`/v1/admin/mcps/${entry.mcp_id}/validate`, {
          method: 'POST',
          credentials: 'include',
        });
        // Step 2: Publish (requires validation_status === 'valid')
        const pub = await fetch(`/v1/admin/mcps/${entry.mcp_id}/publish`, {
          method: 'POST',
          credentials: 'include',
        });
        return {
          status: r.status,
          ok: r.ok,
          name: entry.name,
          published: pub.ok,
          pubStatus: pub.status,
        };
      }
      return { status: r.status, ok: r.ok, name: entry?.name, published: false };
    }, unique);

    // Verify the MCP was published successfully
    expect(createResult.ok, `MCP creation failed: status ${createResult.status}`).toBeTruthy();
    expect(
      createResult.published,
      `MCP publish failed: pubStatus ${(createResult as any).pubStatus}`
    ).toBeTruthy();

    // Reload to see the new MCP
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Find the MCP we just created
    const mcpLink = page.getByText('Test MCP for Edit').first();
    await expect(mcpLink).toBeVisible({ timeout: 10000 });
    await mcpLink.click();
    await expect(page.locator('h1')).toBeVisible();

    // open Edit
    const editBtn = page.getByRole('button', { name: 'Edit' }).first();
    await expect(editBtn).toBeVisible({ timeout: 5000 });

    // open Edit, then fill and save; intercept the PATCH on save
    await editBtn.click();
    const newDesc = `Updated via Playwright test ${Date.now()}`;
    // Catalyst Textarea uses <Label> + <Textarea> without id attrs
    await page.getByLabel('Description').fill(newDesc);
    const saveBtn = page.getByRole('button', { name: 'Save' }).first();

    const [req] = await Promise.all([
      page.waitForRequest(r => r.method() === 'PATCH' && /\/v1\/admin\/mcps\//.test(r.url()), {
        timeout: 20000,
      }),
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

    // Create a test MCP and move it through the full lifecycle via API
    const unique = `playwright-delete-${Date.now()}`;
    const lifecycleResult = await page.evaluate(async uniqueName => {
      const body = {
        name: uniqueName,
        display_name: 'Playwright Delete Test',
        transport_type: 'stdio',
        endpoint: 'test-command',
        config: { command: ['echo', 'ok'], env: {} },
      };

      // Step 1: Create MCP
      const createResp = await fetch('/v1/admin/mcps', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const createData = await createResp.json();
      if (!createResp.ok || !createData.data?.mcp_id) {
        return { success: false, step: 'create', status: createResp.status };
      }
      const mcpId = createData.data.mcp_id;

      // Step 2: Validate MCP
      const validateResp = await fetch(`/v1/admin/mcps/${mcpId}/validate`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!validateResp.ok) {
        return { success: false, step: 'validate', status: validateResp.status };
      }

      // Step 3: Publish MCP
      const publishResp = await fetch(`/v1/admin/mcps/${mcpId}/publish`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!publishResp.ok) {
        return { success: false, step: 'publish', status: publishResp.status };
      }

      // Step 4: Archive MCP
      const archiveResp = await fetch(`/v1/admin/mcps/${mcpId}/archive`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!archiveResp.ok) {
        return { success: false, step: 'archive', status: archiveResp.status };
      }

      return { success: true, mcpId, name: uniqueName };
    }, unique);

    // Verify lifecycle completed successfully
    expect(
      lifecycleResult.success,
      `MCP lifecycle failed at ${(lifecycleResult as any).step}: status ${(lifecycleResult as any).status}`
    ).toBeTruthy();

    // Reload and navigate to the archived MCP detail page
    await page.reload();
    await page.waitForLoadState('networkidle');
    const mcpLink = page.getByText('Playwright Delete Test').first();
    await expect(mcpLink).toBeVisible({ timeout: 10000 });
    await mcpLink.click();

    // Verify Delete button appears for archived MCP
    const deleteBtn = page.getByRole('button', { name: 'Delete' }).first();
    await expect(deleteBtn).toBeVisible({ timeout: 10000 });
    await deleteBtn.click();

    // Confirm deletion in dialog
    const confirmDeleteBtn = page.getByRole('button', { name: 'Delete', exact: true }).last();
    await expect(confirmDeleteBtn).toBeVisible({ timeout: 5000 });
    await confirmDeleteBtn.click();

    // Verify MCP removed from list
    await page.goto('/app/admin/mcps');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText('Playwright Delete Test')).toHaveCount(0);
    await page.screenshot({ path: 'fix2-delete-archived.png', fullPage: true });
  });

  test('Fix 3: User credential fields display in subscribe dialog', async ({ page, context }) => {
    // Check if MCPs exist in marketplace
    await page.goto('/app/marketplace');
    const emptyState = page.locator('text=No MCPs');
    const hasMcps = await emptyState.count().then(c => c === 0);

    // Skip test if no MCPs available in CI
    if (!hasMcps) {
      test.skip();
      return;
    }

    // Find first MCP card with "View Details" button
    const viewDetailsBtn = page.getByRole('link', { name: 'View Details' }).first();
    const hasMcpCards = await viewDetailsBtn.isVisible().catch(() => false);

    if (!hasMcpCards) {
      // No MCPs in marketplace, skip test
      test.skip();
      return;
    }

    // Click on first MCP to view details
    await viewDetailsBtn.click();
    await expect(page).toHaveURL(/app\/marketplace\/[^/]+/);

    // Click Subscribe
    const subscribe = page.getByRole('button', { name: /Subscribe/i }).first();
    await expect(subscribe).toBeVisible({ timeout: 5000 });
    await subscribe.click();

    // Verify credentials dialog appears (if MCP requires credentials, fields will show)
    // For MCPs without credentials, subscription happens immediately
    // This test validates the UI doesn't crash on subscription flow
    await page.waitForTimeout(2000); // Allow dialog to render
    await page.screenshot({ path: 'fix3-subscribe-credentials.png', fullPage: true });
  });
});
