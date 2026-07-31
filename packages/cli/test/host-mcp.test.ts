import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  HOST_CONFIG_PATHS,
  hostSurveyBlock,
  hostSurveyClause,
  hostSurveyInitBeat,
  surveyHostConfigs,
} from '../src/host-mcp';

/**
 * Every fixture is a temp directory written by this file — the survey must never
 * be provable only on the machine of whoever wrote it. Nothing here reads the
 * developer's real `$HOME`, and nothing here needs an MCP server installed,
 * which is also the point: the survey is a file read, deliberately not a
 * connection.
 */
const roots: string[] = [];

const makeRoot = ({ files }: { files: Record<string, string> }): string => {
  const root = mkdtempSync(join(tmpdir(), 'orangerail-hosts-'));
  roots.push(root);

  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }

  return root;
};

/** The head-to-head arm D fixture, reduced: postgres-mcp and orangerail side by side. */
const BOTH_MOUNTED = JSON.stringify({
  mcpServers: {
    postgres: {
      command: '/tmp/.venv/bin/postgres-mcp',
      args: ['--access-mode=restricted', 'postgresql://someone:hunter2@localhost:5432/freetest'],
    },
    orangerail: {
      command: '/usr/local/bin/node',
      args: ['/repo/packages/cli/dist/main.js', 'mcp', '--config', '/repo/orangerail.config.mjs'],
      env: { DATABASE_URL: 'postgresql://someone:hunter2@localhost:5432/freetest' },
    },
  },
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('surveyHostConfigs', () => {
  it('names the foreign server and not our own when both are mounted (AC-1)', () => {
    const review = surveyHostConfigs({
      projectRoot: makeRoot({ files: { '.mcp.json': BOTH_MOUNTED } }),
    });

    expect(review.state).toBe('shared');
    expect(review.foreign).toEqual([{ name: 'postgres', source: '.mcp.json' }]);
    expect(review.governed).toEqual([{ name: 'orangerail', source: '.mcp.json' }]);
  });

  it('reports a config holding only orangerail as exclusive (AC-2)', () => {
    const review = surveyHostConfigs({
      projectRoot: makeRoot({
        files: {
          '.mcp.json': JSON.stringify({
            mcpServers: {
              // Named anything at all — identification is by what executes, not
              // by the label the user chose.
              rail: { command: 'npx', args: ['-y', 'orangerail', 'mcp'] },
            },
          }),
        },
      }),
    });

    expect(review.state).toBe('exclusive');
    expect(review.foreign).toEqual([]);
    expect(review.governed).toEqual([{ name: 'rail', source: '.mcp.json' }]);
  });

  it('reports "cannot tell" rather than clean when no host config exists (AC-3)', () => {
    const review = surveyHostConfigs({ projectRoot: makeRoot({ files: {} }) });

    expect(review.state).toBe('unmounted');
    expect(review.sources).toEqual([]);
  });

  it('never treats an entry name as evidence of what runs', () => {
    const review = surveyHostConfigs({
      projectRoot: makeRoot({
        files: {
          '.mcp.json': JSON.stringify({
            mcpServers: { orangerail: { command: '/usr/bin/postgres-mcp', args: ['--all'] } },
          }),
        },
      }),
    });

    expect(review.state).toBe('shared');
    expect(review.foreign).toEqual([{ name: 'orangerail', source: '.mcp.json' }]);
  });

  it('surveys .cursor and .vscode, and understands both root keys (AC-9)', () => {
    const review = surveyHostConfigs({
      projectRoot: makeRoot({
        files: {
          '.cursor/mcp.json': JSON.stringify({ mcpServers: { slack: { command: 'slack-mcp' } } }),
          '.vscode/mcp.json': JSON.stringify({ servers: { github: { command: 'gh-mcp' } } }),
        },
      }),
    });

    expect(review.state).toBe('shared');
    expect(review.foreign).toEqual([
      { name: 'slack', source: join('.cursor', 'mcp.json') },
      { name: 'github', source: join('.vscode', 'mcp.json') },
    ]);
  });

  it('counts an HTTP server with no command as declared and ungoverned', () => {
    const review = surveyHostConfigs({
      projectRoot: makeRoot({
        files: {
          '.mcp.json': JSON.stringify({
            mcpServers: { remote: { type: 'http', url: 'https://example.test/mcp' } },
          }),
        },
      }),
    });

    expect(review.foreign).toEqual([{ name: 'remote', source: '.mcp.json' }]);
  });

  it('reports an unparseable config as unaccounted for, never as clean (AC-10)', () => {
    const review = surveyHostConfigs({
      projectRoot: makeRoot({
        files: {
          // The JSONC shape VS Code permits. Naming the file beats a hand-rolled
          // comment stripper, and it must not read as "declares nothing".
          '.vscode/mcp.json': '// my servers\n{ "servers": { "postgres": { "command": "pg" } } }',
        },
      }),
    });

    expect(review.state).toBe('exclusive');
    expect(review.unreadable).toHaveLength(1);
    expect(review.unreadable[0]?.source).toBe(join('.vscode', 'mcp.json'));
    expect(hostSurveyBlock({ review })).toContain('unaccounted for');
  });

  it('reports a non-object root as unreadable', () => {
    const review = surveyHostConfigs({
      projectRoot: makeRoot({ files: { '.mcp.json': '["postgres"]' } }),
    });

    expect(review.unreadable[0]?.detail).toBe('root is not a JSON object');
  });

  it('says a config declaring no servers declares none, not "orangerail only"', () => {
    const review = surveyHostConfigs({
      projectRoot: makeRoot({ files: { '.mcp.json': JSON.stringify({ mcpServers: {} }) } }),
    });

    expect(review.state).toBe('exclusive');
    expect(hostSurveyBlock({ review })).toContain('declares no MCP servers');
  });

  it('reports the same name from two files once per file', () => {
    const review = surveyHostConfigs({
      projectRoot: makeRoot({
        files: {
          '.mcp.json': JSON.stringify({ mcpServers: { postgres: { command: 'pg' } } }),
          '.cursor/mcp.json': JSON.stringify({ mcpServers: { postgres: { command: 'pg' } } }),
        },
      }),
    });

    expect(review.foreign).toEqual([
      { name: 'postgres', source: '.mcp.json' },
      { name: 'postgres', source: join('.cursor', 'mcp.json') },
    ]);
  });
});

describe('the bound this survey does not cross', () => {
  it('reads project scope only — no path escapes the project root (AC-6)', () => {
    for (const path of HOST_CONFIG_PATHS) {
      expect(path.startsWith('/')).toBe(false);
      expect(path.startsWith('~')).toBe(false);
      expect(path.split('/')).not.toContain('..');
    }
  });

  it('opens no process and no socket (AC-7)', () => {
    const source = readFileSync(new URL('../src/host-mcp.ts', import.meta.url), 'utf8');

    expect(source).not.toContain('node:child_process');
    expect(source).not.toContain('node:net');
    expect(source).not.toContain('tools/list');
  });

  it('carries no vendor name — the signal is "we do not govern it", not a blocklist', () => {
    const source = readFileSync(new URL('../src/host-mcp.ts', import.meta.url), 'utf8');

    expect(source.toLowerCase()).not.toContain('postgres-mcp');
  });
});

describe('hostSurveyBlock', () => {
  it('prints no command, arg or env value from a foreign entry (AC-5)', () => {
    const review = surveyHostConfigs({
      projectRoot: makeRoot({ files: { '.mcp.json': BOTH_MOUNTED } }),
    });
    const block = hostSurveyBlock({ review });

    expect(block).toContain('postgres (.mcp.json)');
    expect(block).not.toContain('hunter2');
    expect(block).not.toContain('postgresql://');
    expect(block).not.toContain('/tmp/.venv/bin/postgres-mcp');
    expect(block).not.toContain('--access-mode');
  });

  it('states the bound on every variant (AC-4)', () => {
    const shared = surveyHostConfigs({
      projectRoot: makeRoot({ files: { '.mcp.json': BOTH_MOUNTED } }),
    });
    const exclusive = surveyHostConfigs({
      projectRoot: makeRoot({
        files: { '.mcp.json': JSON.stringify({ mcpServers: { r: { command: 'orangerail' } } }) },
      }),
    });
    const unmounted = surveyHostConfigs({ projectRoot: makeRoot({ files: {} }) });

    for (const review of [shared, exclusive, unmounted]) {
      const block = hostSurveyBlock({ review });

      expect(block).toContain('Project scope only');
      expect(block).toContain('machine-scope MCP config is not read');

      for (const path of HOST_CONFIG_PATHS) {
        expect(block).toContain(path);
      }
    }

    expect(hostSurveyBlock({ review: unmounted })).toContain('cannot tell what');
  });

  it('never claims a foreign server is unsafe — only that it is ungoverned here', () => {
    const review = surveyHostConfigs({
      projectRoot: makeRoot({ files: { '.mcp.json': BOTH_MOUNTED } }),
    });
    const block = hostSurveyBlock({ review });

    expect(block).toContain('UNGOVERNED TOOLS ALONGSIDE');
    expect(block).toContain('orangerail does not gate those tools');
    expect(block.toLowerCase()).not.toContain('unsafe');
    expect(block.toLowerCase()).not.toContain('dangerous');
  });
});

describe('hostSurveyClause', () => {
  it('is present only when something foreign is declared (AC-11)', () => {
    const shared = surveyHostConfigs({
      projectRoot: makeRoot({ files: { '.mcp.json': BOTH_MOUNTED } }),
    });
    const unmounted = surveyHostConfigs({ projectRoot: makeRoot({ files: {} }) });

    expect(hostSurveyClause({ review: shared })).toContain('1 ungoverned MCP server(s) alongside');
    expect(hostSurveyClause({ review: unmounted })).toBe('');
  });
});

describe('hostSurveyInitBeat', () => {
  it('fires with the server named when one is declared (AC-8)', () => {
    const beat = hostSurveyInitBeat({
      review: surveyHostConfigs({
        projectRoot: makeRoot({ files: { '.mcp.json': BOTH_MOUNTED } }),
      }),
    });

    expect(beat.tick).toContain('postgres (.mcp.json)');
    expect(beat.body).toContain('not the only one your agent can reach');
    expect(beat.body).not.toContain('hunter2');
  });

  it('says nothing when no host config exists — absence is normal right after init (AC-8)', () => {
    const beat = hostSurveyInitBeat({
      review: surveyHostConfigs({ projectRoot: makeRoot({ files: {} }) }),
    });

    expect(beat).toEqual({ tick: '', body: '' });
  });
});
