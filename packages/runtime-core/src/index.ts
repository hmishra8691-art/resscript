/**
 * @resscript/runtime-core — pure functions for P1-09 (Deliverable E).
 *
 * Seeded PRNG (ADR-006), page state machine, piping, validation execution.
 * All functions are pure: identical inputs → identical outputs, replayable
 * across Node, browser, and QuickJS.
 */

export { deriveKey, permute, sfc32Counter, testDistributionUniformity, testPermuteDeterminism } from './prng.js';
