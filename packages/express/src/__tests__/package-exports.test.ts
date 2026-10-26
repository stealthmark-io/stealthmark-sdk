import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

interface PackageJson {
  type?: string;
  exports: Record<string, Record<string, string>>;
}

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as PackageJson;

describe('package exports', () => {
  // Without a `default` condition, require() from a CommonJS project (tsx/ts-node tests, CommonJS
  // Express apps) fails with ERR_PACKAGE_PATH_NOT_EXPORTED. With it, Node 20.19+ and 22.12+ load the
  // ESM build through require(esm).
  it('resolves the root entry for require() as well as import', () => {
    const root = pkg.exports['.'];
    expect(pkg.type).toBe('module');
    expect(root.default).toBe(root.import);
    expect(Object.keys(root).at(-1)).toBe('default');
  });
});
