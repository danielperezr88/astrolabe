/**
 * Type declarations for @huggingface/transformers (optional dependency).
 *
 * This shim prevents TS2307 when the package is not installed (optional deps
 * can fail silently in CI). The runtime code uses dynamic import() with
 * try/catch, so it degrades gracefully when unavailable.
 *
 * @see #865
 */
declare module '@huggingface/transformers' {
  export function pipeline(
    task: string,
    model: string,
    options?: Record<string, unknown>,
  ): Promise<any>;
}
