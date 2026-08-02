import { describe, expect, it } from 'vitest';

import { keepAliveFor, parseArgs } from '../src/args';

describe('argv — the resolved subcommand drives keep-alive (ONT-044 A)', () => {
  it('keeps a long-running command alive when a flag comes BEFORE the subcommand', () => {
    // The pre-fix check was `LONG_RUNNING.has(process.argv[2])`, i.e. the raw
    // first token, which here is `--config`: the studio server printed
    // "serving" and the process exited on the next tick.
    const argv = ['--config', './orangerail.config.mjs', 'studio', '--no-open', '--port', '4860'];
    const args = parseArgs({ argv });

    expect(args.positional).toEqual(['studio']);
    expect(args.configPath).toBe('./orangerail.config.mjs');
    expect(args.port).toBe(4860);
    expect(keepAliveFor({ args, code: 0 })).toBe(true);
  });

  it('keeps mcp and init alive in either flag order', () => {
    for (const argv of [
      ['mcp', '--config', 'c.mjs'],
      ['--config', 'c.mjs', 'mcp'],
      ['init', '--yes'],
      ['--yes', 'init'],
    ]) {
      expect(keepAliveFor({ args: parseArgs({ argv }), code: 0 })).toBe(true);
    }
  });

  it('never keeps a short command alive, whatever the flag order', () => {
    for (const argv of [
      ['status'],
      ['--config', 'c.mjs', 'status'],
      ['approvals', 'list'],
      ['docs', '--out', 'out'],
    ]) {
      expect(keepAliveFor({ args: parseArgs({ argv }), code: 0 })).toBe(false);
    }
  });

  it('does not hang on `studio --help` / `--version`, which never start a server', () => {
    expect(keepAliveFor({ args: parseArgs({ argv: ['studio', '--help'] }), code: 0 })).toBe(false);
    expect(keepAliveFor({ args: parseArgs({ argv: ['studio', '-v'] }), code: 0 })).toBe(false);
    expect(keepAliveFor({ args: parseArgs({ argv: [] }), code: 2 })).toBe(false);
  });

  it('exits rather than lingering when a long-running command failed', () => {
    expect(keepAliveFor({ args: parseArgs({ argv: ['studio'] }), code: 1 })).toBe(false);
  });
});

describe('argv — unknown flags fail loudly (ONT-044 B)', () => {
  it('rejects an unrecognized flag instead of ignoring it', () => {
    expect(() => parseArgs({ argv: ['status', '--frobnicate'] })).toThrow(
      /unknown flag "--frobnicate"/,
    );
  });

  it('rejects a MISSPELLED --config rather than auditing the local project', () => {
    // The dangerous instance: `--confg <prod>` used to be swallowed into
    // `positional`, so `status` read ./orangerail.config.mjs and reported a
    // confident green posture for the wrong project, exit 0.
    expect(() => parseArgs({ argv: ['status', '--confg', '/path/to/prod.config.mjs'] })).toThrow(
      /unknown flag "--confg"/,
    );
  });

  it('names the valid set in the error, like an unknown --preset value does', () => {
    expect(() => parseArgs({ argv: ['status', '--confg', 'x'] })).toThrow(/--config/);
  });

  it('rejects a bare dash and an unknown short flag', () => {
    expect(() => parseArgs({ argv: ['status', '-'] })).toThrow(/unknown flag/);
    expect(() => parseArgs({ argv: ['status', '-x'] })).toThrow(/unknown flag "-x"/);
  });

  it('rejects a value handed to a boolean flag', () => {
    expect(() => parseArgs({ argv: ['studio', '--no-open=false'] })).toThrow(
      /--no-open does not take a value/,
    );
  });

  it('still accepts non-flag positionals', () => {
    const args = parseArgs({ argv: ['approvals', 'show', 'a1b2-c3d4', '--full'] });

    expect(args.positional).toEqual(['approvals', 'show', 'a1b2-c3d4']);
    expect(args.full).toBe(true);
  });

  it('still accepts the bare word `help`', () => {
    expect(parseArgs({ argv: ['help'] }).help).toBe(true);
  });
});

describe('argv — a missing flag value fails loudly (ONT-044 C)', () => {
  it('rejects --config with nothing after it instead of falling back to the local config', () => {
    expect(() => parseArgs({ argv: ['status', '--config'] })).toThrow(
      /--config requires a value — nothing followed it/,
    );
  });

  it('rejects --out with nothing after it instead of writing to the default path', () => {
    expect(() => parseArgs({ argv: ['docs', '--out'] })).toThrow(/--out requires a value/);
  });

  it('rejects a value flag whose value is the next flag', () => {
    expect(() => parseArgs({ argv: ['--config', '--port', '4820', 'studio'] })).toThrow(
      /--config requires a value — the next token was "--port"/,
    );
  });

  it('rejects an empty inline value', () => {
    expect(() => parseArgs({ argv: ['status', '--config='] })).toThrow(/--config requires a value/);
  });

  it('covers every value flag', () => {
    for (const flag of [
      '--config',
      '--out',
      '--port',
      '--preset',
      '--sources',
      '--models',
      '--exclude',
      '--from-jira',
      '--from-slack',
    ]) {
      expect(() => parseArgs({ argv: ['init', flag] })).toThrow(
        new RegExp(`${flag} requires a value`),
      );
    }
  });

  it('accepts the --flag=value form for the path flags', () => {
    const args = parseArgs({ argv: ['docs', '--config=./a.mjs', '--out=./docs'] });

    expect(args.configPath).toBe('./a.mjs');
    expect(args.outPath).toBe('./docs');
  });
});

describe('argv — --port is validated as a port (ONT-044 C/D)', () => {
  it('rejects a non-numeric port naming the flag, not with a raw Node error', () => {
    // Pre-fix this surfaced as
    // "options.port should be >= 0 and < 65536. Received type number (NaN)".
    expect(() => parseArgs({ argv: ['studio', '--port', 'abc'] })).toThrow(
      /--port must be an integer between 0 and 65535 — got "abc"/,
    );
  });

  it('rejects out-of-range and fractional ports', () => {
    for (const value of ['65536', '70000', '1.5']) {
      expect(() => parseArgs({ argv: ['studio', '--port', value] })).toThrow(/--port must be/);
    }

    // A negative port can only arrive inline — as a separate token it is caught
    // one layer earlier, by the missing-value guard.
    expect(() => parseArgs({ argv: ['studio', '--port=-1'] })).toThrow(/--port must be/);
    expect(() => parseArgs({ argv: ['studio', '--port', '-1'] })).toThrow(
      /--port requires a value/,
    );
  });

  it('accepts 0 (ask the OS for an ephemeral port) and a normal port', () => {
    expect(parseArgs({ argv: ['studio', '--port', '0'] }).port).toBe(0);
    expect(parseArgs({ argv: ['studio', '--port=4860'] }).port).toBe(4860);
  });
});

/**
 * `--exclude` (ONT-059) parses exactly like `--models`: same CSV shape, same
 * required value. Both decide which tables an agent can reach, so a difference
 * in how they are typed would be a difference nobody expects.
 */
describe('--exclude', () => {
  it('parses a CSV list on init and on sync', () => {
    expect(parseArgs({ argv: ['init', '--exclude', 'payment, api_credential'] }).exclude).toEqual([
      'payment',
      'api_credential',
    ]);
    expect(parseArgs({ argv: ['sync', '--exclude=payment'] }).exclude).toEqual(['payment']);
  });

  it('is absent, not empty, when the flag is not given', () => {
    expect(parseArgs({ argv: ['sync'] }).exclude).toBeUndefined();
  });
});

/**
 * `--studio` / `--no-studio` (ONT-077). The wizard's flag-only default is now
 * `false`, so what `parseArgs` resolves these two to decides whether a server
 * comes up — pinned here rather than left implicit.
 */
describe('--studio / --no-studio', () => {
  it('is undefined when neither flag is given, which is what the default keys off', () => {
    expect(parseArgs({ argv: ['init', '--yes'] }).studio).toBeUndefined();
  });

  it('resolves each flag to its own value', () => {
    expect(parseArgs({ argv: ['init', '--yes', '--studio'] }).studio).toBe(true);
    expect(parseArgs({ argv: ['init', '--yes', '--no-studio'] }).studio).toBe(false);
  });

  it('lets the last flag win when both are passed', () => {
    expect(parseArgs({ argv: ['init', '--no-studio', '--studio'] }).studio).toBe(true);
    expect(parseArgs({ argv: ['init', '--studio', '--no-studio'] }).studio).toBe(false);
  });

  it('reads -y exactly as --yes, so the default reaches the alias too', () => {
    expect(parseArgs({ argv: ['init', '-y'] }).yes).toBe(true);
    expect(parseArgs({ argv: ['init', '-y'] }).studio).toBeUndefined();
  });
});
