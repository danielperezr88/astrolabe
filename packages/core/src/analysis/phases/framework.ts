/**
 * Pipeline Phase: Framework Detection
 *
 * Calls detectFrameworks() which reads package.json, requirements.txt,
 * go.mod, Cargo.toml etc. and creates Framework nodes in the graph (#152).
 */

import type { PhaseDefinition, PhaseContext } from '../../core/pipeline.js';
import { detectFrameworks, type FrameworkInfo } from '../framework-detection.js';

export interface FrameworkOutput {
  frameworks: FrameworkInfo[];
}

export const frameworkPhase: PhaseDefinition<FrameworkOutput> = {
  name: 'framework',
  dependencies: ['structure'],

  execute(context: PhaseContext): FrameworkOutput {
    const { graph } = context;
    const frameworks = detectFrameworks(context.repoPath, graph);
    return { frameworks };
  },
};
