/**
 * Shared definitions for the prod-only build's hostname scrubbing.
 *
 * A prod build has to remove non-prod hostnames from more than compiled code.
 * The VSIX also ships `launch-mcp.sh`, `README.md`, and `docs/**`, and the npm
 * tarball ships `launch-mcp.sh`, `README.md`, and `CHANGELOG.md`. Every one of
 * those carried a `dev.fort.blue` or `mesa.red` example, and every one of them
 * lands on a user's disk.
 *
 * Nothing here guesses at what ships. `scripts/verify-prod-artifacts.mjs`
 * opens the built `.vsix` and `.tgz` and greps every entry, so a file missed
 * by this list fails the build rather than shipping quietly.
 */

/**
 * Substrings that must not survive a prod build. Fragments rather than whole
 * URLs, so a trailing slash or a changed path cannot turn a real leak into a
 * pass.
 */
export const FORBIDDEN = ['mesa.red', 'fort.blue', 'localhost:3020', 'localhost:3010'];

/**
 * Non-prod URLs rewritten to their prod counterparts, longest first so
 * `https://api-next.dev.fort.blue` is consumed before any shorter prefix of
 * it. Rewriting beats deleting: a usage example that keeps its shape stays
 * useful, where a hole in the middle of a docs table does not.
 */
export const REWRITES = [
  ['https://mcp-next.dev.fort.blue/mcp', 'https://mcp.fortmesa.com/mcp'],
  ['https://mcp-latest.dev.fort.blue/mcp', 'https://mcp.fortmesa.com/mcp'],
  ['https://api-next.dev.fort.blue', 'https://api.fortmesa.com'],
  ['https://api-latest.dev.fort.blue', 'https://api.fortmesa.com'],
  ['https://mcp-next.dev.fort.blue', 'https://mcp.fortmesa.com'],
  ['https://mcp-latest.dev.fort.blue', 'https://mcp.fortmesa.com'],
  ['http://localhost:3020/mcp', 'https://mcp.fortmesa.com/mcp'],
  ['http://localhost:3020', 'https://mcp.fortmesa.com'],
  ['http://localhost:3010', 'https://api.fortmesa.com'],
];

/** Text files that ship in the VSIX, the npm tarball, or both. */
export const SHIPPED_TEXT = ['launch-mcp.sh', 'README.md', 'CHANGELOG.md', 'docs/VSIX.md', 'docs/CONFIG-REFERENCE.md'];

/**
 * Apply {@link REWRITES}, then drop any line still holding a forbidden
 * fragment.
 *
 * The line drop is the backstop for prose that names a host without a full
 * URL ("the dev-mfisch pod on mesa.red"), which no URL rewrite can repair.
 * Losing a line from a shipped doc beats shipping an internal hostname.
 */
export function scrubText(contents) {
  let out = contents;
  for (const [from, to] of REWRITES) out = out.split(from).join(to);
  return out
    .split('\n')
    .filter((line) => !FORBIDDEN.some((needle) => line.includes(needle)))
    .join('\n');
}
