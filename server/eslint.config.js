import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'test/fixtures/**', '**/*.d.ts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // The codebase deliberately uses `any` at transport/codec boundaries and for test doubles.
      '@typescript-eslint/no-explicit-any': 'off',
      // Unused vars are errors, but an underscore prefix marks an intentional placeholder.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // Empty catch blocks are used deliberately (dead subscriber / best-effort cleanup).
      'no-empty': ['error', { allowEmptyCatch: true }],
      // `const self = this` is a legitimate pattern around callbacks here.
      '@typescript-eslint/no-this-alias': 'off',
      // Control-char classes appear in protocol parsing regexes.
      'no-control-regex': 'off',
    },
  },
  {
    files: ['test/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-expressions': 'off',
    },
  },
  {
    // Frida instrumentation scripts (global functions injected by the Frida runtime).
    files: ['scripts/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        ...globals.node,
        Module: 'readonly',
        Interceptor: 'readonly',
        NativeFunction: 'readonly',
        Memory: 'readonly',
        Process: 'readonly',
        ptr: 'readonly',
      },
    },
  },
);
