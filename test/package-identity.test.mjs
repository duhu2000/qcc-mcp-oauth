import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const pkg = JSON.parse(read('../package.json'));

test('package and bundle keep their independent plugin identity', () => {
  assert.equal(pkg.name, 'qcc-dsh-mcp-oauth');
  const bundle = read('../cordis.patch.yml');
  assert.match(bundle, /name: 'qcc-dsh-mcp-oauth'/);
  assert.match(bundle, /id: qcc-mcp-oauth\s/);
  assert.equal(bundle.includes("name: 'qcc-dsh-mcp-legal-oauth'"), false);
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    assert.equal(pkg[field]?.['qcc-dsh-mcp-legal-oauth'], undefined);
  }
});
