import { cp, readdir } from 'node:fs/promises';

/** HOME is a tmpfs at run time: the image's defaults (CLI configs) are copied in first, never overwriting. */
export async function seedHome(skeleton: string, home: string): Promise<void> {
  const entries = await readdir(skeleton).catch(() => []);
  for (const entry of entries)
    await cp(`${skeleton}/${entry}`, `${home}/${entry}`, {
      recursive: true,
      force: false,
      errorOnExist: false,
    });
}
