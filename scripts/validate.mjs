import { readFile, access } from 'node:fs/promises';

const required = ['manifest.json', 'background.js', 'content.js', 'popup.html', 'popup.css', 'popup.js', 'PRIVACY.md'];
await Promise.all(required.map((file) => access(new URL(`../${file}`, import.meta.url))));

const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
if (manifest.manifest_version !== 3) throw new Error('manifest_version must be 3');
if (manifest.version !== '0.9.1') throw new Error('package and manifest versions are out of sync');

const allowedPermissions = new Set(['storage', 'tabs', 'scripting', 'alarms']);
for (const permission of manifest.permissions || []) {
  if (!allowedPermissions.has(permission)) throw new Error(`Unexpected permission: ${permission}`);
}

for (const file of ['background.js', 'content.js', 'popup.js']) {
  const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
  if (!source.trim()) throw new Error(`${file} is empty`);
}

console.log('Extension validation passed.');
