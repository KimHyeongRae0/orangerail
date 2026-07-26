import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '.docs/**',
      '.claude/**',
      // Runnable demonstration projects (codegen output + hand-written drivers),
      // kept as-emitted rather than conformed to library source style.
      'examples/**',
      // Captured codegen golden — must stay byte-identical to the shipped
      // emitter output (ONT-018 AC-6), so it is never reformatted/linted.
      'tests/e2e/fixtures/**/openapi-reference/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      /** Functions are always arrow expressions assigned to const (CLAUDE.md convention). */
      'func-style': ['error', 'expression'],
      'prefer-arrow-callback': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
);
