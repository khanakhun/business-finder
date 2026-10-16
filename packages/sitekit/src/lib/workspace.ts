import { lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

// The workspace sitekit works in (BF-042): every path is resolved against its root, and a path that leaves it —
// absolute, `..`, or through a symlink pointing outside — is refused. Files have size limits.

export class WorkspaceError extends Error {
  constructor(
    readonly code: 'outside_workspace' | 'not_found' | 'too_large' | 'not_a_file' | 'invalid_json',
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

/** Default read limit; `site.json` is held to 1 MB by the config's `limits.specBytes`. */
export const MAX_READ_BYTES = 5 * 1024 * 1024;

export class Workspace {
  private constructor(readonly root: string) {}

  static async open(dir: string): Promise<Workspace> {
    const root = await realpath(resolve(dir)).catch(() => {
      throw new WorkspaceError('not_found', `The workspace ${dir} does not exist.`);
    });
    if (!(await stat(root)).isDirectory())
      throw new WorkspaceError('not_a_file', `${dir} is not a directory.`);
    return new Workspace(root);
  }

  private inside(path: string): boolean {
    const rel = relative(this.root, path);
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
  }

  /** The absolute path of a workspace file; refuses paths (and symlinks) leaving the workspace. */
  async resolve(path: string): Promise<string> {
    if (path.includes('\0'))
      throw new WorkspaceError('outside_workspace', 'A path may not contain NUL bytes.');
    const absolute = resolve(this.root, path);
    if (!this.inside(absolute))
      throw new WorkspaceError('outside_workspace', `${path} is outside the workspace (${this.root}).`);
    // The nearest existing ancestor (or the file itself) must stay inside once symlinks are resolved.
    let probe = absolute;
    for (;;) {
      const real = await realpath(probe).catch(() => undefined);
      if (real !== undefined) {
        if (!this.inside(real))
          throw new WorkspaceError(
            'outside_workspace',
            `${path} leads outside the workspace through a link.`,
          );
        break;
      }
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    return absolute;
  }

  async exists(path: string): Promise<boolean> {
    return lstat(await this.resolve(path)).then(
      () => true,
      () => false,
    );
  }

  async readText(path: string, maxBytes = MAX_READ_BYTES): Promise<string> {
    const absolute = await this.resolve(path);
    const info = await stat(absolute).catch(() => {
      throw new WorkspaceError('not_found', `${path} does not exist in the workspace.`);
    });
    if (!info.isFile()) throw new WorkspaceError('not_a_file', `${path} is not a file.`);
    if (info.size > maxBytes)
      throw new WorkspaceError('too_large', `${path} is ${info.size} bytes; the limit is ${maxBytes}.`);
    return readFile(absolute, 'utf8');
  }

  async readJson(path: string, maxBytes = MAX_READ_BYTES): Promise<unknown> {
    const text = await this.readText(path, maxBytes);
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new WorkspaceError(
        'invalid_json',
        `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}.`,
      );
    }
  }

  async writeText(path: string, text: string | Uint8Array): Promise<string> {
    const absolute = await this.resolve(path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, text);
    return absolute;
  }
}
