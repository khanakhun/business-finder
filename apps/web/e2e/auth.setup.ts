import { mkdirSync, writeFileSync } from 'node:fs';
import { test as setup } from '@playwright/test';
import { createVerifiedUser } from './users.ts';

/**
 * One signed-in workspace owner for the authenticated specs (sign-up → verification link from Mailpit → sign-in
 * → two workspaces). Done through the API; the UI flows themselves are covered by auth.spec.ts.
 */
setup('create a verified workspace owner', async ({ request }) => {
  const owner = await createVerifiedUser(request, 'owner', ['Agence SBH', 'Second Workspace']);
  mkdirSync(new URL('./.auth', import.meta.url), { recursive: true });
  writeFileSync(new URL('./.auth/owner-credentials.json', import.meta.url), JSON.stringify(owner));
  await request.storageState({ path: new URL('./.auth/owner.json', import.meta.url).pathname });
});
