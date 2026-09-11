/**
 * The Settings › Agents row labels (PO, 2026-09-05 + refinement 6a).
 *
 * What was wrong. The section rendered one free-text sentence per row, each
 * a different length and each describing a different KIND of fact:
 * "detected", "not detected on this machine", "supported by this host". The
 * PO's verdict — "the strings used here are not delightful … why is one
 * string more verbose? … no idea what supported on this host means … I don't
 * even know what the possible values are here". A first pass swapped in
 * chips reading "Detected"/"Configured" and the PO could still not tell
 * those two apart, which is the real defect: both words describe the
 * MECHANISM rather than the fact a person cares about.
 *
 * The fix is two everyday facts, shown together on every row, always the
 * same two questions in the same order:
 *
 *   1. **Is the agent on this machine?**  Installed / Not installed —
 *      or "This editor" for the IDE Saferoom is itself running inside,
 *      which is present by definition and can never be "installed" by the
 *      user.
 *   2. **Is FortMesa wired into it?**  Connected / Not connected.
 *
 * Everything else — a detection probe that threw, a host with no MCP
 * provider API — collapses to a single "Needs attention" chip whose tooltip
 * names the cause. No sentence-length statuses, no state word that needs
 * the code to interpret.
 *
 * Deliberately `vscode`-free and pure: the mapping is exhaustively unit
 * tested in `test/registry/agent-status.test.mjs`. The DETECTION logic is
 * untouched by this module — it only labels what detection already found.
 */

/** The machine-side fact about an agent, as detection reports it. */
export type AgentPresence =
  /** Found on this machine (CLI on PATH, or its config directory exists). */
  | 'installed'
  /** Not found on this machine. */
  | 'not-installed'
  /** The editor Saferoom is running in — present by definition. */
  | 'this-editor'
  /** Detection could not answer, or the host cannot host the integration at all. */
  | 'needs-attention';

export interface AgentRowInput {
  /** The `ideSync` target key (`claude`, `vscode`, …) — the on-disk identity. */
  readonly target: string;
  readonly presence: AgentPresence;
  /**
   * Whether FortMesa's MCP server entry is wired into this agent.
   *
   * ⚠️ Sourced from `config.json`'s `ideSync.<target>` flag — the state the
   * sync pass projects (it writes the entry when on and REMOVES it when
   * off), not a fresh per-file read of the agent's own config. It is
   * therefore accurate to the last sync pass, which is also what the row's
   * checkbox has always shown. A live per-agent "is our entry actually
   * there" probe does not exist in `registry/projectors/**` — every
   * projector exposes `detect()` (presence) and `project()` (a write), and
   * adding a read-only probe was explicitly out of scope for this round
   * ("keep the state detection logic unchanged").
   */
  readonly connected: boolean;
  /** The cause, when `presence` is `needs-attention`. Surfaced as that chip's tooltip. */
  readonly attentionDetail?: string;
}

export interface AgentChip {
  readonly label: string;
  readonly tooltip: string;
  /** Which of the two questions this chip answers — drives its styling only. */
  readonly kind: 'presence' | 'fortmesa' | 'attention';
}

export interface AgentRowLabels {
  /** The agent's human name, for the row title. */
  readonly name: string;
  /** One or two chips, always in presence-then-FortMesa order. */
  readonly chips: readonly AgentChip[];
  /** A single short line, present only when it adds something the chips do not. */
  readonly hint?: string;
  /** True when an inline "Connect" action should be offered (present, but not wired up). */
  readonly canConnect: boolean;
}

/**
 * Human names for the six sync targets. The row used to print the raw
 * config key (`claude`, `codex`), which is the on-disk identity and not a
 * label; the tooltips 6a specifies name the agent, so they need this.
 */
const AGENT_NAMES: Record<string, string> = {
  claude: 'Claude Code',
  vscode: 'VS Code',
  cursor: 'Cursor',
  codex: 'Codex',
  antigravity: 'Antigravity',
  copilot: 'GitHub Copilot',
};

/** The display name for a target key, falling back to the key itself for an unknown one. */
export function agentName(target: string): string {
  return AGENT_NAMES[target] ?? target;
}

function fortmesaChip(name: string, connected: boolean): AgentChip {
  return connected
    ? { label: 'Connected', tooltip: `FortMesa is configured in ${name}'s MCP settings`, kind: 'fortmesa' }
    : { label: 'Not connected', tooltip: `FortMesa is not configured in ${name}'s MCP settings`, kind: 'fortmesa' };
}

/** Map one agent's detection state to its row labels. Total over {@link AgentPresence} — every state has a label. */
export function agentRowLabels(input: AgentRowInput): AgentRowLabels {
  const name = agentName(input.target);

  switch (input.presence) {
    case 'installed':
      return {
        name,
        chips: [
          { label: 'Installed', tooltip: `Found ${name} on this machine`, kind: 'presence' },
          fortmesaChip(name, input.connected),
        ],
        canConnect: !input.connected,
      };

    case 'this-editor':
      return {
        name,
        chips: [
          { label: 'This editor', tooltip: `${name} is the editor Saferoom is running in`, kind: 'presence' },
          fortmesaChip(name, input.connected),
        ],
        canConnect: !input.connected,
      };

    // Nothing to connect TO, so the FortMesa chip would be noise: the row
    // carries the one fact plus the one thing the user can do about it.
    case 'not-installed':
      return {
        name,
        chips: [{ label: 'Not installed', tooltip: `${name} was not found on this machine`, kind: 'presence' }],
        hint: `Install ${name} to connect it`,
        canConnect: false,
      };

    case 'needs-attention':
      return {
        name,
        chips: [
          {
            label: 'Needs attention',
            tooltip:
              input.attentionDetail !== undefined && input.attentionDetail.length > 0
                ? input.attentionDetail
                : `Saferoom could not determine ${name}'s state on this machine`,
            kind: 'attention',
          },
        ],
        ...(input.attentionDetail !== undefined && input.attentionDetail.length > 0
          ? { hint: input.attentionDetail }
          : {}),
        canConnect: false,
      };
  }
}
