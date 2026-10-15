#!/usr/bin/env node
// Writes infra/compose/seccomp-chromium.json (BF-026): Docker's default seccomp profile (moby/profiles, Apache-2.0)
// at a pinned commit, plus the user-namespace syscalls Chromium's sandbox needs. The intel container renders
// untrusted pages: Chromium's sandbox stays on, and this is the narrowest profile that lets it start under
// `cap_drop: [ALL]` + `no-new-privileges`. To update: pick a moby/profiles commit at least two weeks old, change
// COMMIT, run `node scripts/infra/seccomp-chromium.mjs`, review the diff, commit both.
import { writeFile } from 'node:fs/promises';

const COMMIT = '6fe7deb1b9fb7c0397a4593480d7d22b9ee8caef';
const SOURCE = `https://raw.githubusercontent.com/moby/profiles/${COMMIT}/seccomp/default.json`;
const TARGET = new URL('../../infra/compose/seccomp-chromium.json', import.meta.url);

const response = await fetch(SOURCE, { signal: AbortSignal.timeout(30_000) });
if (!response.ok) throw new Error(`${SOURCE}: HTTP ${response.status}`);
const profile = await response.json();
profile.syscalls.push({
  names: ['clone', 'clone3', 'unshare', 'setns', 'chroot'],
  action: 'SCMP_ACT_ALLOW',
  comment: `BF-026: Chromium's namespace sandbox. Base: moby/profiles@${COMMIT} seccomp/default.json`,
});
await writeFile(TARGET, `${JSON.stringify(profile, null, 2)}\n`);
console.log(`wrote ${TARGET.pathname}`);
