import type { ModifierProjection } from "../src/schemas.js";

export const EMPTY_PROJECTION_FINGERPRINT = `sha256:${"0".repeat(64)}`;

export function emptyModifierProjection(): ModifierProjection {
  return {
    version: 1,
    inventory: { version: 1, sections: [], lineFlags: [], sourceFamilies: [] },
    items: [],
    modifierCount: 0,
    activeModifierCount: 0,
    unresolvedModifierCount: 0,
    descriptions: { entries: [], truncated: false },
    fingerprint: EMPTY_PROJECTION_FINGERPRINT,
  };
}
