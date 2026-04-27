/**
 * @astrolabe/cli — CLI entry point.
 *
 * Command-line interface for Astrolabe. Built with Commander.js.
 * Currently a skeleton — commands will be added in subsequent issues.
 */

import { program } from 'commander';

program
  .name('astrolabe')
  .description('Codebase knowledge graph analysis tool')
  .version('0.1.0');

program
  .command('version')
  .description('Show version information')
  .action(() => {
    console.log('astrolabe v0.1.0');
  });

program.parse();
