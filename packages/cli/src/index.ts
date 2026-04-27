#!/usr/bin/env node
/**
 * @astrolabe/cli — CLI entry point.
 *
 * Command-line interface for Astrolabe. Built with Commander.js.
 */

import { program } from 'commander';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));

program
  .name('astrolabe')
  .description('Codebase knowledge graph analysis tool')
  .version(pkg.version);

program
  .command('version')
  .description('Show version information')
  .action(() => {
    console.log(`astrolabe v${pkg.version}`);
  });

program.parse();
