import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures.ts';
import { linkFromEmail } from './mailpit.ts';
import { nextClientIp, signedInAsNewUser } from './users.ts';

const owner = () =>
  JSON.parse(readFileSync(new URL('./.auth/owner-credentials.json', import.meta.url), 'utf8')) as {
    email: string;
    password: string;
    name: string;
  };

test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('sends visitors to sign-in and back to the page they asked for', async ({ page }) => {
    await page.goto('/search');
    await expect(page).toHaveURL(/\/sign-in\?next=%2Fsearch$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    await page.getByLabel('Email').fill(owner().email);
    await page.getByLabel('Password', { exact: true }).fill(owner().password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(/\/search$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Search' })).toBeVisible();
  });

  test('shows a localized error for wrong credentials', async ({ page }) => {
    await page.goto('/sign-in');
    await page.getByLabel('Email').fill(owner().email);
    await page.getByLabel('Password', { exact: true }).fill('definitely not the password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByText('Wrong email or password.')).toBeVisible();
  });

  for (const path of ['/sign-in', '/sign-up', '/forgot-password']) {
    test(`${path} has no serious or critical axe violations`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
    });
  }
});

test('switches workspace from the top bar', async ({ browser }) => {
  const { page, close } = await signedInAsNewUser(browser, 'switch', ['Harbour', 'Lagoon']);
  await page.goto('/');
  const switcher = page.getByRole('button', { name: 'Switch workspace' });
  await expect(switcher).toHaveText(/Harbour/);
  await switcher.click();
  await page.getByRole('menuitem', { name: /Lagoon/ }).click();
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toHaveText(/Lagoon/);
  await close();
});

test('invites a member who joins through the emailed link', async ({ page, browser, request }) => {
  const email = `e2e-invitee-${Date.now()}@example.test`;
  await page.goto('/settings/members');
  await expect(page.getByRole('heading', { level: 1, name: 'Members' })).toBeVisible();
  await page.getByRole('button', { name: 'Invite member' }).click();
  await page.getByRole('dialog').getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByRole('region', { name: 'Pending invitations' }).getByText(email)).toBeVisible();

  const inviteLink = await linkFromEmail(request, email, '/invite/');
  const invitee = await (
    await browser.newContext({
      storageState: { cookies: [], origins: [] },
      extraHTTPHeaders: { 'X-Forwarded-For': nextClientIp() },
    })
  ).newPage();
  await invitee.goto(inviteLink);
  await invitee.getByRole('link', { name: 'Create account' }).click();
  await invitee.getByLabel('Full name').fill('Ivy Invitee');
  await invitee.getByLabel('Email').fill(email);
  await invitee.getByLabel('Password', { exact: true }).fill('invitee long passphrase');
  await invitee.getByRole('button', { name: 'Create account' }).click();
  await expect(invitee.getByRole('status')).toContainText(email);

  // The confirmation link signs the invitee in; then they accept.
  await invitee.goto(await linkFromEmail(request, email, '/api/auth/verify-email'));
  await expect(invitee.getByRole('heading', { level: 1, name: 'Email confirmed' })).toBeVisible();
  await invitee.goto(inviteLink);
  await expect(invitee.getByRole('heading', { level: 1, name: /Join Agence SBH/ })).toBeVisible();
  await invitee.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(invitee.getByRole('button', { name: 'Switch workspace' })).toHaveText(/Agence SBH/);
  await invitee.context().close();
});

// Its own user: turning 2FA on for the shared owner would change how the other specs sign in.
test('two-factor setup shows a QR code to scan', async ({ browser }) => {
  const { page, user, close } = await signedInAsNewUser(browser, 'totp', ['TOTP Workspace']);
  await page.goto('/settings/account');
  const section = page.getByRole('region', { name: 'Two-factor authentication' });
  await section.getByRole('button', { name: 'Enable' }).click();
  await section.getByLabel('Confirm with your password').fill(user.password);
  await section.getByRole('button', { name: 'Enable' }).click();
  await expect(page.getByTestId('totp-qr')).toBeVisible();
  await expect(section.getByLabel('Code', { exact: true })).toBeVisible();
  await close();
});

test('the members settings page has no serious or critical axe violations', async ({ page }) => {
  await page.goto('/settings/members');
  await expect(page.getByRole('heading', { level: 1, name: 'Members' })).toBeVisible();
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
});
