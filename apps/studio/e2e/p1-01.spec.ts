/**
 * P1-01's acceptance journey, as a Playwright spec.
 *
 * NOT RUN BY `pnpm test`, deliberately: `vitest.config.ts` scopes its `include` to `src/**`, so
 * this file is only executed by `pnpm test:e2e` in an environment that has a browser, a running
 * studio, and a migrated Supabase. It is committed now because the journey is the acceptance
 * criterion, and an acceptance criterion nobody wrote down is one nobody runs.
 *
 * What it asserts, in P1-01's own words:
 *   - invite -> accept -> role enforcement;
 *   - "a user in org A, authenticated normally, sees exactly org A's projects";
 *   - an `owner` cannot be created by invitation;
 *   - "changing a member from programmer to viewer causes their next save to fail with a
 *     permission error".
 *
 * Preconditions (CI provides them; the spec asserts them rather than creating them silently):
 *   STUDIO_BASE_URL, and four seeded accounts whose passwords are in the environment.
 */

import { expect, test, type Page } from '@playwright/test';

interface Account {
  readonly email: string;
  readonly password: string;
}

function account(prefix: string): Account {
  const email = process.env[prefix + '_EMAIL'];
  const password = process.env[prefix + '_PASSWORD'];
  if (email === undefined || password === undefined) {
    throw new Error(
      'missing ' + prefix + '_EMAIL / ' + prefix + '_PASSWORD — see e2e/README in the milestone report',
    );
  }
  return { email, password };
}

async function signIn(page: Page, who: Account): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
}

test.describe('P1-01 tenancy acceptance', () => {
  test('invite -> accept -> role enforcement', async ({ page }) => {
    const ownerA = account('ORG_A_OWNER');
    const newcomer = account('NEWCOMER');

    // 1. An admin issues an invitation. The token is shown exactly once.
    await signIn(page, ownerA);
    await page.getByTestId('org-switcher-label').waitFor();
    const orgUrl = new URL(page.url());
    const orgId = orgUrl.pathname.split('/')[1] ?? '';
    expect(orgId).toMatch(/^org_/);

    await page.goto('/' + orgId + '/settings/invitations');
    await page.getByLabel('Email').fill(newcomer.email);
    await page.getByLabel('Role').selectOption('programmer');
    await page.getByRole('button', { name: 'Send invitation' }).click();

    const tokenBox = page.locator('code');
    await expect(tokenBox).toBeVisible();
    const token = ((await tokenBox.textContent()) ?? '').trim();
    expect(token.length).toBeGreaterThan(20);

    // 2. `owner` is not an option in the invitation role list at all — the API refuses it and
    //    `invitations_role_not_owner` refuses it again, so the UI must not offer it.
    const roleOptions = await page.getByLabel('Role').locator('option').allTextContents();
    expect(roleOptions).not.toContain('owner');

    await signOut(page);

    // 3. The invitee accepts and lands in the org they were invited to.
    await signIn(page, newcomer);
    await page.goto('/accept-invite?token=' + encodeURIComponent(token));
    await page.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(page).toHaveURL(new RegExp('/' + orgId));

    // 4. Role enforcement: a programmer can create a survey but NOT a project
    //    (`projects_insert` is project_manager and above).
    await page.goto('/' + orgId + '/projects');
    await page.getByLabel('Ref').fill('E2EPRJ');
    await page.getByLabel('Name').fill('Should be refused');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('alert')).toContainText(/project_manager|requires/i);

    await signOut(page);
  });

  test('a user in org A sees exactly org A projects', async ({ page }) => {
    const ownerA = account('ORG_A_OWNER');
    const ownerB = account('ORG_B_OWNER');

    await signIn(page, ownerA);
    const orgA = (new URL(page.url()).pathname.split('/')[1] ?? '');
    await page.goto('/' + orgA + '/projects');
    const aRefs = await page.locator('table tbody tr td:first-child').allTextContents();
    expect(aRefs.length).toBeGreaterThan(0);
    await signOut(page);

    await signIn(page, ownerB);
    const orgB = (new URL(page.url()).pathname.split('/')[1] ?? '');
    expect(orgB).not.toBe(orgA);
    await page.goto('/' + orgB + '/projects');
    const bRefs = await page.locator('table tbody tr td:first-child').allTextContents();

    // Disjoint sets. Not "B sees fewer" — no overlap at all.
    for (const ref of bRefs) expect(aRefs).not.toContain(ref);

    // And org A's URL, visited with org B's token, redirects to the switcher rather than
    // rendering org A's shell (UI §2: the path is never the authorization input).
    await page.goto('/' + orgA + '/projects');
    await expect(page).toHaveURL(/\/orgs/);
    await signOut(page);
  });

  test('demoting a programmer to viewer makes their next save fail', async ({ page }) => {
    const ownerA = account('ORG_A_OWNER');
    const programmer = account('ORG_A_PROGRAMMER');

    // Baseline: the programmer can create a survey.
    await signIn(page, programmer);
    const orgId = new URL(page.url()).pathname.split('/')[1] ?? '';
    await page.goto('/' + orgId + '/projects');
    await page.locator('table tbody tr td:first-child a').first().click();
    await page.getByLabel('Ref').fill('E2EOK');
    await page.getByLabel('Name').fill('Before demotion');
    await page.getByRole('button', { name: 'Create survey' }).click();
    await expect(page.getByRole('cell', { name: 'E2EOK' })).toBeVisible();
    await signOut(page);

    // The owner demotes them to viewer.
    await signIn(page, ownerA);
    await page.goto('/' + orgId + '/settings/members');
    const row = page.getByLabel('Role for ' + programmer.email);
    await row.selectOption('viewer');
    await expect(page.getByText('saving…')).toHaveCount(0);
    await signOut(page);

    // The same save now fails with a permission error — the role is read from the membership
    // row, so the demotion takes effect on the next request, not at token expiry.
    await signIn(page, programmer);
    await page.goto('/' + orgId + '/projects');
    await page.locator('table tbody tr td:first-child a').first().click();
    await page.getByLabel('Ref').fill('E2ENOPE');
    await page.getByLabel('Name').fill('After demotion');
    await page.getByRole('button', { name: 'Create survey' }).click();
    await expect(page.getByRole('alert')).toContainText(/programmer|requires/i);
    await expect(page.getByRole('cell', { name: 'E2ENOPE' })).toHaveCount(0);
  });
});
