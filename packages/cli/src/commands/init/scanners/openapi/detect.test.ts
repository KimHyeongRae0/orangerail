import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openapiScanner } from './scan';

/**
 * ONT-042 C — `isOpenApiJson` swallowed the JSON parse error and returned
 * `false`, so `detect` filtered a malformed `openapi.json` out before the
 * scanner ever ran. The scanner's own `could not parse` warning was unreachable
 * dead code on that path, and a user with one trailing comma was told their spec
 * did not exist. `detect` touches the real filesystem, so each case builds a
 * throwaway repo under a fresh temp dir.
 */
describe('openapiScanner.detect (ONT-042 C — a spec that does not parse still exists)', () => {
  let cwd: string;

  const write = ({ name, content }: { name: string; content: string }): void => {
    writeFileSync(join(cwd, name), content, 'utf8');
  };

  const detectRel = (): string[] =>
    openapiScanner.detect({ cwd }).map((abs) => abs.slice(cwd.length + 1));

  /** The exact QA reproduction: a valid 3.0 spec with one trailing comma. */
  const TRAILING_COMMA =
    '{"openapi":"3.0.0","info":{},"paths":{"/a":{"post":{"operationId":"doA"}}},}';

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'ont-042-openapi-detect-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('claims a conventionally named openapi.json that does not parse', () => {
    write({ name: 'openapi.json', content: TRAILING_COMMA });

    expect(detectRel()).toEqual(['openapi.json']);
  });

  it('surfaces the real syntax error, naming the file, once the file is claimed', () => {
    write({ name: 'swagger.json', content: TRAILING_COMMA });

    const [filePath] = openapiScanner.detect({ cwd });
    const scanned = openapiScanner.scan({ filePath: filePath as string });

    const warning = scanned.warnings.find((w) => /could not parse/.test(w));
    expect(warning).toContain('swagger.json');
    expect(warning).toMatch(/trailing comma/);
    expect(scanned.actions).toHaveLength(0);
  });

  it('still ignores a root JSON file that parses into something that is not a spec', () => {
    write({ name: 'openapi.json', content: '{"not":"a spec"}' });

    expect(detectRel()).toEqual([]);
  });

  it('does not claim an unrelated broken JSON file that is not conventionally named', () => {
    write({ name: 'tsconfig.json', content: '{ /* comments are not JSON */ }' });
    write({ name: 'package.json', content: '{"name":"x",}' });

    expect(detectRel()).toEqual([]);
  });

  it('still finds a well-formed spec by content when no conventional name exists', () => {
    write({ name: 'api-spec.json', content: '{"openapi":"3.0.0","paths":{}}' });

    expect(detectRel()).toEqual(['api-spec.json']);
  });
});
