import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import semver from 'semver';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('DSH peer ranges accept supported release candidates and reject unrelated versions', () => {
  for (const name of ['@deepseek-ai/dsh-mcp-client', '@deepseek-ai/dsh-storage-domain']) {
    const range = pkg.peerDependencies[name];
    for (const version of ['0.1.0-rc.6', '0.2.0-rc.2']) {
      assert.equal(semver.satisfies(version, range), true, `${name}: ${version}`);
    }
    for (const version of ['0.1.0-rc.5', '0.2.0-rc.1', '0.3.0-rc.1', '1.0.0']) {
      assert.equal(semver.satisfies(version, range), false, `${name}: ${version}`);
    }
  }
});

test('Cordis peer uses the DSH package name', () => {
  assert.ok(pkg.peerDependencies['@deepseek-ai/cordis']);
  assert.equal(pkg.peerDependencies.cordis, undefined);
});
