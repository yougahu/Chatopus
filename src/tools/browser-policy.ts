import { promises as fs } from 'node:fs';
import path from 'node:path';
import { confinedPath } from './paths.js';

/** Public-page interaction tools; arbitrary code and upload tools stay outside this surface. */
export const BROWSER_TOOLS = new Set([
  'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_select_option',
  'browser_fill_form', 'browser_type', 'browser_wait_for', 'browser_take_screenshot',
  'browser_navigate_back', 'browser_find', 'browser_hover', 'browser_press_key',
  'browser_tabs', 'browser_close', 'browser_resize', 'browser_handle_dialog',
  'browser_drag', 'browser_emulate_media', 'browser_console_messages',
]);

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) {
    throw new Error(`Invalid browser ${label}`);
  }
  return value;
}

/** Prepare host-confined arguments without changing the caller's object. */
export async function prepareBrowserArguments(
  name: string,
  args: Record<string, unknown>,
  workspace: string,
  validateUrl: (url: string) => unknown,
): Promise<Record<string, unknown>> {
  if (!BROWSER_TOOLS.has(name)) throw new Error('Browser tool unavailable');
  const prepared = { ...args };
  if (name === 'browser_navigate') validateUrl(text(args.url, 'URL', 4000));
  // A new tab with no URL uses the browser's empty about:blank page. Explicit
  // destinations, including those supplied with another action, are validated.
  if (name === 'browser_tabs' && args.url !== undefined) validateUrl(text(args.url, 'URL', 4000));

  if (args.filename !== undefined) {
    const root = await fs.realpath(workspace);
    const filename = text(args.filename, 'filename', 1000);
    const target = await confinedPath(root, filename, true);
    // Reject even in-workspace aliases: an otherwise harmless name could point
    // at a private host directory used for internal state.
    const parts = path.relative(root, path.resolve(root, filename)).split(path.sep);
    let current = root;
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]);
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) throw new Error('Browser output paths must not traverse symlinks');
        if (index === parts.length - 1 && !stat.isFile()) throw new Error('Browser output must name a regular file');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        break;
      }
    }
    const relative = path.relative(root, target);
    if (!relative || relative.split(path.sep).some(part => part.startsWith('.'))) {
      throw new Error('Private host paths are not writable browser artifacts');
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    prepared.filename = target;
  }
  return prepared;
}
