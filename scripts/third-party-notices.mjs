/** Generate a reproducible dependency inventory from the committed lockfile. */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const lock = JSON.parse(readFileSync(new URL('package-lock.json', root), 'utf8'));
const direct = new Set(Object.keys(lock.packages[''].dependencies ?? {}));
const records = new Map();
for (const [path, pkg] of Object.entries(lock.packages)) {
  if (!path) continue;
  const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
  if (!pkg.version || !pkg.license) throw new Error('Dependency version or license missing: ' + name);
  records.set(name + '@' + pkg.version, { name, version: pkg.version, license: pkg.license, direct: direct.has(name) });
}
const rows = [...records.values()].sort((a, b) => (a.name + '@' + a.version).localeCompare(b.name + '@' + b.version, 'en'));
const content = `# Third-party notices

Chatopus source is licensed under MIT. Dependencies retain their own licenses and copyright notices; Chatopus's license does not replace them.

This inventory is generated from package-lock.json, including development, transitive and optional platform packages. A particular installation may use a subset. Registry links identify the exact upstream package and version; installed packages contain their license files and attribution. No third-party source or binary is vendored by this source release.

Some optional native packages use LGPL-3.0-or-later (libvips) or MPL-2.0 (Lightning CSS). If distributing a container, executable, modified dependency or bundled node_modules, collect the corresponding upstream notices, license texts and source/relinking materials required for that distribution. This inventory alone is not a binary distribution notice bundle. External browsers, OpenViking, models, skills and plugins are installed separately and are not covered by this list.

Regenerate with \`npm run notices:write\`; verify with \`npm run notices:check\`. Review license changes when updating dependencies.

| Package | Version | License (upstream metadata) | Dependency |
| --- | --- | --- | --- |
${rows.map(p => `| [${p.name}](https://www.npmjs.com/package/${p.name}/v/${p.version}) | ${p.version} | ${p.license.replaceAll('|', '\\|')} | ${p.direct ? 'direct runtime' : 'development / transitive / optional'} |`).join('\n')}
`;
const destination = new URL('THIRD_PARTY_NOTICES.md', root);
if (process.argv.length === 3 && process.argv[2] === '--write') {
  writeFileSync(destination, content);
  console.log('Updated ' + fileURLToPath(destination) + ' (' + rows.length + ' packages)');
} else if (process.argv.length === 2 || process.argv.length === 3 && process.argv[2] === '--check') {
  if (readFileSync(destination, 'utf8') !== content) throw new Error('Third-party inventory is stale; run npm run notices:write and review changes');
  console.log('Third-party inventory matches lockfile (' + rows.length + ' packages)');
} else throw new Error('Usage: node scripts/third-party-notices.mjs [--write|--check]');
