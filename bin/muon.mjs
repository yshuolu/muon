#!/usr/bin/env node
// Resolves the repository's TypeScript runtime independently of the caller's cwd.
import { register } from 'tsx/esm/api';
register();
await import('../src/cli/main.ts');
