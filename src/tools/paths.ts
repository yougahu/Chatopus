import { promises as fs } from 'node:fs';
import path from 'node:path';
const inside = (root: string, file: string) => file === root || file.startsWith(root + path.sep);
export async function confinedPath(root: string, relative: string, write = false): Promise<string> {
  if (path.isAbsolute(relative)) throw new Error('Use a relative path inside the selected root');
  root = path.resolve(root);
  const target = path.resolve(root, relative);
  const realRoot = await fs.realpath(root);
  if (!inside(root, target)) throw new Error('Path escapes selected root');
  if (write) {
    // Resolve the nearest existing ancestor before creating anything. Returning
    // that canonical candidate also lets callers enforce private subdirectories.
    let ancestor = target;
    for (;;) {
      try { await fs.lstat(ancestor); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw error;
        ancestor = parent;
        continue;
      }
      // A dangling symlink is an error, not a missing directory we may skip.
      const resolved = await fs.realpath(ancestor);
      if (!inside(realRoot, resolved)) throw new Error('Symlink escapes selected root');
      const candidate = path.resolve(resolved, path.relative(ancestor, target));
      if (!inside(realRoot, candidate)) throw new Error('Path escapes selected root');
      return candidate;
    }
  }
  const real = await fs.realpath(target);
  if (!inside(realRoot, real)) throw new Error('Symlink escapes selected root');
  return real;
}
