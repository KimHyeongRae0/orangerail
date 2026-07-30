import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';

import type { McpPreset } from 'orangerail-mcp';

import { DEFAULT_GATE, GATE_POLICIES, type GatePolicy } from './codegen';

/**
 * The hand-rolled survey wizard (plan D8). Zero dependencies: prompts run on
 * `node:readline/promises`. Every question has a non-interactive flag
 * equivalent, so an agent/CI drives the whole flow with flags only (AC-3). A
 * non-TTY stdin without `--yes` is refused with the exact flag set to use —
 * agents must be explicit, which prevents a silent full-default generation in
 * CI. I/O streams and the TTY signal are injected so the flag path and the
 * refusal path are unit-testable without a PTY.
 */

const VALID_PRESETS: McpPreset[] = ['readonly', 'approval-for-writes', 'sandbox'];

/** Raw init flags parsed from argv (undefined = "not specified, use default"). */
export interface InitFlags {
  yes: boolean;
  preset?: string | undefined;
  gate?: string | undefined;
  sources?: string[] | undefined;
  models?: string[] | undefined;
  docs?: boolean | undefined;
  studio?: boolean | undefined;
  open: boolean;
  port?: number | undefined;
  fromJira?: string | undefined;
  fromSlack?: string | undefined;
}

/** The fully-resolved survey answers codegen + completion flow consume. */
export interface ResolvedInit {
  preset: McpPreset;
  gate: GatePolicy;
  sources?: string[] | undefined;
  models?: string[] | undefined;
  docs: boolean;
  studio: boolean;
  open: boolean;
  port?: number | undefined;
}

/** Wizard outcome: resolved answers or an explicit refusal with a message. */
export type WizardResult = { ok: true; options: ResolvedInit } | { ok: false; message: string };

const REFUSAL = [
  'orangerail init: non-interactive stdin detected without `--yes`.',
  'Re-run with explicit flags, for example:',
  '',
  '  orangerail init --yes \\',
  '    --preset=approval-for-writes --gate=delete \\',
  '    [--sources=prisma,openapi] [--models=Foo,Bar] \\',
  '    [--docs|--no-docs] [--studio|--no-studio] [--no-open] [--port <n>]',
  '',
  'The wizard only prompts on an interactive terminal.',
].join('\n');

const isValidPreset = ({ value }: { value: string }): boolean =>
  (VALID_PRESETS as string[]).includes(value);

/** Resolve a preset from a flag; throws a clear error on an unknown value. */
const resolvePreset = ({ value }: { value: string | undefined }): McpPreset => {
  if (value === undefined) {
    return 'approval-for-writes';
  }

  if (!isValidPreset({ value })) {
    throw new Error(`unknown preset "${value}" — expected one of ${VALID_PRESETS.join(', ')}`);
  }

  return value as McpPreset;
};

/**
 * Resolve `--gate` from a flag; throws a clear error on an unknown value, the
 * same contract `--preset` has (ONT-056).
 *
 * The two flags sit at different layers and both are needed. `--preset` decides
 * what the SERVER does with the ontology at runtime — `readonly` exposes no
 * action tools, `sandbox` dry-runs them, `approval-for-writes` runs them "as
 * declared". `--gate` decides what "as declared" MEANS, by choosing which
 * generated files carry `policy: { approval: 'required' }`. Under `readonly`
 * the gate changes nothing an agent can reach, because no action tool is served.
 */
const resolveGate = ({ value }: { value: string | undefined }): GatePolicy => {
  if (value === undefined) {
    return DEFAULT_GATE;
  }

  if (!(GATE_POLICIES as string[]).includes(value)) {
    throw new Error(`unknown gate "${value}" — expected one of ${GATE_POLICIES.join(', ')}`);
  }

  return value as GatePolicy;
};

const affirmative = ({ answer, fallback }: { answer: string; fallback: boolean }): boolean => {
  const trimmed = answer.trim().toLowerCase();

  if (trimmed === '') {
    return fallback;
  }

  return trimmed === 'y' || trimmed === 'yes';
};

/** Build the flag-only (non-interactive) resolution. */
const fromFlags = ({ flags }: { flags: InitFlags }): ResolvedInit => ({
  preset: resolvePreset({ value: flags.preset }),
  gate: resolveGate({ value: flags.gate }),
  ...(flags.sources === undefined ? {} : { sources: flags.sources }),
  ...(flags.models === undefined ? {} : { models: flags.models }),
  docs: flags.docs ?? true,
  studio: flags.studio ?? true,
  open: flags.open,
  ...(flags.port === undefined ? {} : { port: flags.port }),
});

/**
 * Run the survey. `--yes` (or any non-TTY caller that passed `--yes`) resolves
 * purely from flags + defaults. On a real TTY without `--yes`, a question is
 * asked ONLY when its flag was not supplied — a provided flag is the answer and
 * is never re-asked (D8). A non-TTY caller without `--yes` is refused (agent/CI
 * parity).
 */
export const runWizard = async ({
  flags,
  stdin,
  stdout,
  isTTY,
}: {
  flags: InitFlags;
  stdin: Readable;
  stdout: Writable;
  isTTY: boolean;
}): Promise<WizardResult> => {
  if (flags.yes) {
    return { ok: true, options: fromFlags({ flags }) };
  }

  if (!isTTY) {
    return { ok: false, message: REFUSAL };
  }

  const rl = createInterface({ input: stdin, output: stdout });

  try {
    // A question already answered by its flag is NEVER re-asked (plan D8): a
    // provided flag IS the answer. Only undefined flags become prompts.
    let sources = flags.sources;
    if (sources === undefined) {
      const answer = await rl.question('Import which sources? (csv, blank = all) ');
      sources =
        answer.trim() === ''
          ? undefined
          : answer
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s !== '');
    }

    let models = flags.models;
    if (models === undefined) {
      const answer = await rl.question('Import which models? (csv, blank = all) ');
      models =
        answer.trim() === ''
          ? undefined
          : answer
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s !== '');
    }

    let preset: McpPreset;
    if (flags.preset === undefined) {
      const answer = await rl.question(
        `Policy preset (${VALID_PRESETS.join('/')}) [approval-for-writes] `,
      );
      preset = resolvePreset({ value: answer.trim() === '' ? undefined : answer.trim() });
    } else {
      preset = resolvePreset({ value: flags.preset });
    }

    let gate: GatePolicy;
    if (flags.gate === undefined) {
      const answer = await rl.question(
        `Gate which writes behind human approval? (${GATE_POLICIES.join('/')}) [${DEFAULT_GATE}] `,
      );
      gate = resolveGate({ value: answer.trim() === '' ? undefined : answer.trim() });
    } else {
      gate = resolveGate({ value: flags.gate });
    }

    let docs: boolean;
    if (flags.docs === undefined) {
      const answer = await rl.question('Generate AGENTS.md? [Y/n] ');
      docs = affirmative({ answer, fallback: true });
    } else {
      docs = flags.docs;
    }

    let studio: boolean;
    if (flags.studio === undefined) {
      const answer = await rl.question('Launch studio and open browser? [Y/n] ');
      studio = affirmative({ answer, fallback: true });
    } else {
      studio = flags.studio;
    }

    return {
      ok: true,
      options: {
        preset,
        gate,
        ...(sources === undefined ? {} : { sources }),
        ...(models === undefined ? {} : { models }),
        docs,
        studio,
        open: studio && flags.open,
        ...(flags.port === undefined ? {} : { port: flags.port }),
      },
    };
  } finally {
    rl.close();
  }
};
