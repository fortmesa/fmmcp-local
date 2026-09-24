/**
 * Normalizes a `list_plans` tool result to a bare plans array.
 *
 * FMENG-3162 changed the gateway's `list_plans` result shape from a bare
 * array to `{ plans, hiddenCount, note }` (with `include: "all"` marking
 * each plan active or not). Accepts both shapes so consumers keep working
 * against either an old or new gateway.
 *
 * @param {unknown} response
 * @returns {Array<object>|null} the plans array, or null if neither shape matches
 */
export function normalizeListPlansResult(response) {
  if (Array.isArray(response)) return response;
  if (response && typeof response === 'object' && Array.isArray(response.plans)) {
    return response.plans;
  }
  return null;
}
