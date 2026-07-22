import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { runWizard, type InitFlags } from './wizard';

const baseFlags = (over: Partial<InitFlags> = {}): InitFlags => ({
  yes: false,
  open: true,
  ...over,
});

const streams = () => ({ stdin: new PassThrough(), stdout: new PassThrough() });

describe('runWizard flag parity (AC-3)', () => {
  it('resolves purely from flags under --yes, applying defaults', async () => {
    const { stdin, stdout } = streams();
    const result = await runWizard({
      flags: baseFlags({ yes: true, preset: 'approval-for-writes', open: false }),
      stdin,
      stdout,
      isTTY: false,
    });

    expect(result).toEqual({
      ok: true,
      options: { preset: 'approval-for-writes', docs: true, studio: true, open: false },
    });
  });

  it('threads every flag equivalent through', async () => {
    const { stdin, stdout } = streams();
    const result = await runWizard({
      flags: baseFlags({
        yes: true,
        preset: 'sandbox',
        sources: ['prisma'],
        models: ['Product'],
        docs: false,
        studio: false,
        port: 4879,
      }),
      stdin,
      stdout,
      isTTY: false,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.options).toEqual({
        preset: 'sandbox',
        sources: ['prisma'],
        models: ['Product'],
        docs: false,
        studio: false,
        open: true,
        port: 4879,
      });
    }
  });

  it('rejects an unknown preset', async () => {
    const { stdin, stdout } = streams();

    await expect(
      runWizard({ flags: baseFlags({ yes: true, preset: 'nope' }), stdin, stdout, isTTY: false }),
    ).rejects.toThrow(/unknown preset/);
  });
});

describe('runWizard non-TTY refusal (D8)', () => {
  it('refuses a non-TTY caller without --yes and prints the flag set', async () => {
    const { stdin, stdout } = streams();
    const result = await runWizard({ flags: baseFlags(), stdin, stdout, isTTY: false });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/--yes/);
      expect(result.message).toMatch(/--preset/);
    }
  });
});

describe('runWizard skips questions already answered by a flag (D8)', () => {
  // Every flag supplied EXCEPT the one under test, so at most one prompt is ever
  // read (keeps readline/promises + PassThrough deterministic, no PTY).
  const allButStudio = (): InitFlags =>
    baseFlags({ preset: 'approval-for-writes', sources: [], models: [], docs: true });

  const allFlags = (): InitFlags => ({ ...allButStudio(), studio: true });

  const capture = () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let text = '';
    stdout.on('data', (chunk) => {
      text += chunk.toString('utf8');
    });

    return { stdin, stdout, prompts: () => text };
  };

  it('does not emit the studio question when --no-studio was provided', async () => {
    const { stdin, stdout, prompts } = capture();
    const result = await runWizard({
      flags: { ...allButStudio(), studio: false },
      stdin,
      stdout,
      isTTY: true,
    });

    expect(prompts()).not.toMatch(/studio/i);
    expect(result.ok && result.options.studio).toBe(false);
  });

  it('does not emit the preset question when --preset was provided', async () => {
    const { stdin, stdout, prompts } = capture();
    const result = await runWizard({
      flags: { ...allFlags(), preset: 'readonly' },
      stdin,
      stdout,
      isTTY: true,
    });

    expect(prompts()).not.toMatch(/preset/i);
    expect(result.ok && result.options.preset).toBe('readonly');
  });

  it('does emit the studio question when its flag was NOT provided', async () => {
    const { stdin, stdout, prompts } = capture();
    stdin.write('n\n');

    const result = await runWizard({ flags: allButStudio(), stdin, stdout, isTTY: true });

    expect(prompts()).toMatch(/studio/i);
    expect(result.ok && result.options.studio).toBe(false);
  });
});
