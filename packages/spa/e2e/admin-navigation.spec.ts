import { test, expect } from '@playwright/test';
import { login } from './helpers';

const adminLinks = [
  { name: 'Admin Dashboard', href: '/app/admin/dashboard', heading: 'Admin Dashboard' },
  { name: 'Users', href: '/app/admin/users', heading: 'User Management' },
  { name: 'Groups', href: '/app/admin/groups', heading: 'Group Management' },
  { name: 'MCPs', href: '/app/admin/mcps', heading: 'MCP Management' },
  { name: 'Audit Logs', href: '/app/admin/audit', heading: 'Audit Logs' },
  { name: 'Kill Switches', href: '/app/admin/kill-switches', heading: 'Kill Switches' },
  { name: 'Settings', href: '/app/admin/settings', heading: 'Settings' },
];

const userLinks = [
  { name: 'My Clients', href: '/app/clients', heading: 'My Clients' },
  { name: 'Marketplace', href: '/app/marketplace', heading: 'Marketplace' },
  { name: 'Credentials', href: '/app/credentials', heading: 'Credentials' },
];

test.describe('Admin Sidebar Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await expect(page).toHaveURL(/app\/dashboard/);
  });

  test('admin links navigate and load without errors', async ({ page }) => {
    const sidebar = page.locator('nav');
    for (const link of adminLinks) {
      // Find link by exact text in sidebar
      await sidebar.getByRole('link', { name: link.name, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(link.href));
      await expect(page.getByRole('heading', { name: link.heading, exact: true })).toBeVisible();
      // Basic error checks
      await expect(page.locator('text=Not Found')).toHaveCount(0);
    }
  });

  test('user links navigate and load without errors', async ({ page }) => {
    const sidebar = page.locator('nav');
    for (const link of userLinks) {
      await sidebar.getByRole('link', { name: link.name, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(link.href));
      await expect(page.getByRole('heading', { name: link.heading, exact: true })).toBeVisible();
      await expect(page.locator('text=Not Found')).toHaveCount(0);
    }
  });
});
