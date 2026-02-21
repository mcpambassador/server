import { Page } from '@playwright/test';

export async function login(page: Page, username = 'admin', password = 'admin123') {
  await page.goto('/login');
  // prefer accessible labels, fallback to id selectors
  const userField = page.getByLabel('Username').first();
  if (await userField.isVisible().catch(() => false)) {
    await userField.fill(username);
  } else {
    await page.fill('#username', username).catch(() => {});
  }

  const passField = page.getByLabel('Password').first();
  if (await passField.isVisible().catch(() => false)) {
    await passField.fill(password);
  } else {
    await page.fill('#password', password).catch(() => {});
  }

  const signIn = page.getByRole('button', { name: /Sign in|Sign up|Log in|Login/i }).first();
  if (await signIn.isVisible().catch(() => false)) await signIn.click();
  else await page.click('button[type="submit"]').catch(() => {});

  await page.waitForURL('**/app/dashboard', { timeout: 20000 }).catch(() => {});
}
