# Acceptance — Saferoom VSIX 0.7.9

Round 7 (PO feedback 2026-09-10). Two changes: the Signed-in user card is trimmed, and the
documents tools get a mode switch that actually changes what agents are offered.

Install the **signin** build (`FortMesa-Saferoom-0.7.9-signin.vsix`) for anything touching sandbox
or next; the **prod** build (`FortMesa-Saferoom-0.7.9.vsix` / `-prod.vsix` as built) is prod-only by
construction and cannot reach the dev regions.

---

## A. Signed-in user card (primary sidebar)

### A1 — signed in, healthy credential

1. Sign in (`FortMesa: Sign In`).
2. Look at the **Signed-in user** pane.

**Expect**

- Headline: the user's name, then `· expires in 4 h` — **one** "expires", not two. The exact phrase
  is whatever `formatRelativeExpiry` returns (`in under a minute` / `N min` / `N h` / `N d`).
- Below it: the email.
- Exactly **two** labelled rows: **Data region** and **Expires**.
- **No** `Identity provider` row. **No** `Token ID` row.
- **Expires** is an absolute stamp in **your own locale and time zone**, ending in the short zone
  name — e.g. `9/10/2026, 6:35:07 PM EDT`. On a UTC host it reads `… UTC`; that is correct, not a
  regression.
- Hovering the **name** shows `Identity provider: … · Token ID: …` (only the parts that exist).
- A `Sign out` button — or `Remove` when the credential is a pasted access token.

**Sanity check on the zone**: the hour shown must be the local hour for that instant. If your host
is UTC−4 and the token expires at 22:35 UTC, the row reads `6:35:07 PM EDT`, not `10:35:07 PM`.

### A2 — the facts that moved, not vanished

Open **FortMesa: Settings ▸ Identity**. The table still lists Status, User, Email, User ID,
**Identity provider**, **Token ID**, Data region, Token expires, Time remaining. Nothing was
deleted from the product; it was removed from the _card_.

### A3 — degraded states still render

- **Signed out**: a single primary `Sign in` button, no rows.
- **Expired credential**: the pane leads with the `Session expired` strip and its one-click
  recovery; the two rows are still shown. (Token-only environments offer `Open Settings › Advanced`
  instead of `Sign in again`.)
- **No `/api/v2/me`** (off-sandbox, unreachable): headline falls back to `Signed in`, no email, no
  hover — and the two rows are unchanged. A missing identity must never blank the card.

---

## B. Documents tools mode (Settings ▸ Tools)

### B1 — the split

Open **FortMesa: Settings**, expand **Tools**.

**Expect**

- The general table lists the environment's tools and **does not** contain `grc_documents_read`,
  `grc_documents_write` or `grc_documents_delete`.
- Below it, a **Documents** heading, a two-option switch, a paragraph, and a second table with
  exactly those three tools.
- Options read **Local-file mode** and **Network mode** (sentence case, in that order).
- **Local-file mode is selected** on a machine that has never touched this setting.

### B2 — Local-file mode

Select **Local-file mode**.

- Preamble: the extension handles documents on this machine — agents read and write files by path
  in your workspace, and the extension uploads/downloads through your signed-in session; the
  gateway's URL-based tools are shadowed.
- Rows describe workspace paths (e.g. "download one to a path in your workspace").

**What an agent sees** — in Claude Code (or any connected agent), list the fortmesa tools:

- `grc_documents_read` / `_write` / `_delete` appear **once each**.
- Their input schemas take **paths** (`filePath` / `outputPath`-shaped arguments), not URLs.
- A `grc_documents_write` call with a workspace path succeeds and the bytes leave from this machine.

### B3 — Network mode

Switch to **Network mode**. Do **not** restart the agent.

- The preamble changes to the signed-links text, and explicitly says there is **no local file
  access**.
- The three row descriptions change with it ("return a signed download URL", "the agent transfers
  the bytes itself"). Same three names, different meaning — that is the point.
- **The connected agent's tool list refreshes on its own.** The proxy reloads on the config change
  and sends `notifications/tools/list_changed`. In the agent, the three documents tools now carry
  the **gateway's** schemas: URL-based, no workspace path argument.
- A path-based call that worked in B2 is now rejected by schema validation — the local
  implementation is not exposed at all.
- Non-documents tools (`grc_scopes`, `grc_controls_*`, …) are unaffected in both directions.

If the agent's list does not refresh: some clients ignore `tools/list_changed`. Reconnecting the
MCP server must show the new set — if it does not, that is a real failure.

### B4 — switch back

Return to **Local-file mode**. The agent's list must return to the path-based trio. The switch is
symmetric; nothing is one-way.

### B5 — the checkboxes still work, in both modes

Uncheck `grc_documents_delete`. It disappears from the agent's list in **either** mode, and a direct
call is refused with `tool 'grc_documents_delete' is disabled in Saferoom settings`. Re-check it.

### B6 — persistence

Close and reopen the Settings panel: the selected mode is still selected. It is stored as
`documentsMode` in `~/.fmcode/config.json`, the same file the tool checkboxes write to, and mirrored
to the `fortmesa.documentsMode` VS Code setting. Editing that setting (or the file) by hand moves
the switch, and moves the live tool list with it.

### B7 — a config.json from 0.7.8 still loads

An existing `~/.fmcode/config.json` with no `documentsMode` key must load without error and behave
exactly as 0.7.8 did: Local-file mode, local tools shadowing the gateway's.

---

## Regression sweep (things adjacent to the change)

- Environment switching (Data region) still reloads the proxy and still refreshes the tool list.
- Scope lock still filters `grc_scopes list` and still refuses unauthorised `scopeId`s — in **both**
  documents modes.
- A failed reload still quarantines the proxy (every call refused with an explanation) rather than
  silently serving the environment you left.
- Sign-out from the card still refreshes the Scope selector, the status bar and the Accessible
  scopes panel, not just the card.
