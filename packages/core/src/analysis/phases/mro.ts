/**
 * MRO (Method Resolution Order) for class hierarchies.
 *
 * Computes C3 linearization for multi-inheritance class resolution,
 * producing METHOD_RESOLVES edges that encode dispatch order.
 *
 * Future: integrate with tree-sitter class body parsing for full MRO.
 */
export const mroPhase = {
  name: 'mro',
  dependencies: ['resolution'],
  execute: () => ({ message: 'MRO phase — C3 linearization coming in future release.' }),
};
