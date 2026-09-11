/**
 * The Settings webview's sections: which ones there are, what order they
 * appear in, and which are open when the panel is first opened on a machine.
 *
 * PO, 2026-09-08: *"settings screen … each section should be expand/collapse,
 * with only tools and agents expanded by default. Reorder, agents first (open
 * by default), then tools (open by default), then data region (collapsed by
 * default), identity (collapse by default), scope (collapse by default)."*
 *
 * This supersedes the 2026-09-03 order (Scope, Identity, Tools, Agents, Data
 * region), and the reason for the reversal is worth keeping: the two sections
 * a user actually operates from this panel are Agents and Tools — Scope and
 * Identity are **mirrored read-only** here, their interactive surfaces being
 * the sidebar and the Accessible scopes panel. The old order led with the two
 * sections you cannot act on.
 *
 * It lives in `registry/` rather than in the webview's `<script>` for the same
 * structural reason as `scope-display.ts`: a decision buried in a string
 * literal inside a `vscode`-importing module is unreachable by every test in
 * this repo, and that is exactly how a wrong default ships unnoticed.
 *
 * `vscode`-free on purpose (VSIX-PLAN.md §3.1).
 */

export type SettingsSectionId = 'agents' | 'tools' | 'dataRegion' | 'identity' | 'scope';

export interface SettingsSectionSpec {
  readonly id: SettingsSectionId;
  readonly title: string;
  readonly defaultOpen: boolean;
}

/** Display order IS array order. */
export const SETTINGS_SECTIONS: readonly SettingsSectionSpec[] = [
  { id: 'agents', title: 'Agents', defaultOpen: true },
  { id: 'tools', title: 'Tools', defaultOpen: true },
  { id: 'dataRegion', title: 'Data region', defaultOpen: false },
  { id: 'identity', title: 'Identity', defaultOpen: false },
  { id: 'scope', title: 'Scope', defaultOpen: false },
];

/** The `globalState` key the per-machine open/closed memory is stored under. */
export const SETTINGS_SECTIONS_KEY = 'fortmesa.settings.sections';

export interface SettingsSectionView extends SettingsSectionSpec {
  readonly open: boolean;
}

/**
 * Resolve each section's open state from whatever `globalState` holds.
 *
 * `persisted` is deliberately typed as `unknown`: it comes back from
 * `Memento.get`, which is only as trustworthy as whatever last wrote it —
 * including an older version of this extension with a different section set.
 * Anything unrecognised falls back to the section's own default rather than
 * to "closed", so a section added in a later version still opens the way its
 * author intended on a machine that has old memory.
 */
export function resolveSettingsSections(persisted: unknown): SettingsSectionView[] {
  const stored = typeof persisted === 'object' && persisted !== null ? (persisted as Record<string, unknown>) : {};
  return SETTINGS_SECTIONS.map((section) => {
    const value = stored[section.id];
    return { ...section, open: typeof value === 'boolean' ? value : section.defaultOpen };
  });
}

/** The record to persist after a section is toggled. Only known ids are written, so old keys do not accumulate. */
export function withSectionOpen(
  sections: readonly SettingsSectionView[],
  id: SettingsSectionId,
  open: boolean,
): Record<SettingsSectionId, boolean> {
  const next = {} as Record<SettingsSectionId, boolean>;
  for (const section of sections) {
    next[section.id] = section.id === id ? open : section.open;
  }
  return next;
}

/** Is `value` one of the five section ids? Guards the inbound webview message. */
export function isSettingsSectionId(value: unknown): value is SettingsSectionId {
  return SETTINGS_SECTIONS.some((section) => section.id === value);
}
