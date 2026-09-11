# FortMesa Saferoom — VSIX User Guide

> For humans driving FortMesa from a VS Code-family UI instead of the command
> line. If you'd rather use the terminal, see [README.md](../README.md) — the
> CLI (`fmmcp-local`) and this extension read and write the exact same
> `~/.fmcode/config.json` / `credentials.json` files, so the two stay in
> lockstep no matter which one you use.
>
> **Status**: this describes the build on `feat/saferoom-vsix` after UX Round
> 2 (`.agent/planning/UX-ROUND-2-PLAN.md`) as the code actually stands,
> cross-checked against `src/extension/**` and `src/registry/**` — not the
> aspirational description in `.agent/planning/VSIX-PLAN.md`. Anywhere the
> two disagree, this file says so explicitly and describes the real, current
> behavior. Some gaps below (OAuth sign-in, the `environments` add/edit UX)
> are open, tracked work — see
> [docs/CONFIG-REFERENCE.md](CONFIG-REFERENCE.md) for the full knob-by-knob
> gap list and `.agent/planning/VSIX-PLAN.md` §8/§9 for what's still pending.

> **This extension is now self-contained** — as of UX Round 2 (W1, fixing
> `TODOS.md` T020), `launch-mcp.sh` and a bundled, dependency-free build of
> the CLI (`dist-ext/cli.cjs`) ship INSIDE the `.vsix`, and the extension
> spawns the local MCP from its own install directory
> (`context.extensionPath`) — no open workspace folder is required anymore.
> Earlier builds required this repo checked out and opened as the VS Code
> workspace; that requirement is gone.

## 1. What you're installing

"FortMesa Saferoom" is a VS Code extension that gives you a UI for everything
the `fmmcp-local` CLI can already do: sign in, switch environment, lock the
Saferoom to a scope, and keep the `fortmesa` MCP server registered with the IDEs
you use. It does **not** run its own copy of the local MCP — each agent
(Claude Code, VS Code, Cursor, Codex, Antigravity) still spawns its own
`launch-mcp.sh` process over stdio, exactly as it always has. The extension's
job is purely to edit `~/.fmcode/config.json` and `~/.fmcode/credentials.json`
on your behalf and give you visibility into their current state; every
running local MCP instance picks up a change on its own via hot-reload.

## 2. Installing the extension (sideload)

There is no marketplace listing — this ships as a sideloaded `.vsix` file.

**Build the package** (from the repo root):

```bash
yarn package:ext
```

This runs `tsc` (CLI build), bundles `src/extension/extension.ts` and
`src/local-mcp/cli.ts` with esbuild, and calls `vsce package
--no-dependencies -o "FortMesa-Saferoom-<version>.vsix"`, producing
`FortMesa-Saferoom-<version>.vsix` in the repo root (e.g.
`FortMesa-Saferoom-0.4.0.vsix`) — this exact sequence has been run and
verified sideloadable in this pod. The extension's own identity is
`fortmesa.saferoom` (`package.json`'s `name: "saferoom"` +
`publisher: "fortmesa"`) — distinct from `fmmcp-local`, which names the
repo/CLI/local MCP as a whole; the packaged `.vsix`'s
`bin.fmmcp-local` still points at the CLI (`dist/local-mcp/cli.js`), so the
CLI command name is unaffected by the extension's own identity.
**If you previously sideloaded a build of this extension** (before this
rename), VS Code will NOT treat the new one as an upgrade — it's a
different extension id now. Uninstall the old `fortmesa.fmmcp-local`
entry from the Extensions view before installing this one, or you may end
up with two.

**Install it**, either from a terminal:

```bash
code --install-extension /workspaces/fmmcp-local/FortMesa-Saferoom-0.4.0.vsix
```

or from the Extensions view: click the `···` menu → **Install from VSIX...**
→ pick the file.

**No workspace folder needed.** The extension resolves `launch-mcp.sh` and
the bundled CLI from its own install directory (`context.extensionPath`),
not from any open workspace folder — you can try it in an empty VS Code
window with nothing open.

Once installed, VS Code activates it automatically
(`activationEvents: ["onStartupFinished"]`). If the Saferoom icon doesn't
appear on the activity bar, run **Developer: Reload Window** from the Command
Palette. For anything that doesn't look right, open **View → Output** and
select **FortMesa Saferoom** from the channel dropdown — every command logs
what it did (or why it failed) there, and activation logs the detected host
capabilities (see [§7](#7-ide-sync-behavior)).

## 3. Tour of the Saferoom panels

Click the FortMesa icon in the activity bar to open **three** separate views
(UX Round 2, D-U1 — replacing the old single "Saferoom" tree's four
sections), plus a webview for everything that doesn't fit a tree row well:

```
Scope selector   ● click=switch  ☑=Accessible scopes pane
Signed-in user   [Sign in] · [Sign out]/[Remove] (no confirmation) · ⚠ Session expired → [Sign in again]
Resources        [FortMesa App ↗] [Partner Portal ↗] [Knowledge & Support ↗] [Settings ⧉]
```

A status-bar item on the bottom left reads `$(fortmesa-logo) GRC: <summary>` and is
always visible; clicking it **reveals the Scope selector view**
(`fortmesa.scopes.focus`). It used to open a quick-pick; that command is gone.

**The summary text (PO, 2026-09-09) is one of five states**, computed by the
pure projector `statusBarSummaryFor` (`src/registry/status-bar-summary.ts`,
unit-tested in `test/extension/status-bar-summary.test.mjs`) so a long scope
list can no longer make the bar unreadable:

| Situation                                         | Bar text                                                  |
| ------------------------------------------------- | --------------------------------------------------------- |
| No valid credential for the active environment    | `Not signed-in` (always wins, even with a scope selected) |
| Signed in, exactly one accessible scope           | the scope's own name, e.g. `barsoommsp`                   |
| Signed in, `Run unlocked` mode                    | `Connected`                                               |
| Signed in, more than one accessible scope         | `Connected`                                               |
| Signed in, zero accessible scopes (a legal state) | `Connected · no scopes`                                   |

The full accessible-scope list still lives in the item's **tooltip**
(truncated at 10 names with a trailing `(+n more)`), so nothing the old
`GRC: <scopes>` text showed is lost — it moved rather than disappeared. The
projector reacts to both config.json changes (env/scope-lock switches, via
`applyConfig`) and the identity-events bus (sign in/out/paste-a-token, via
`onIdentityChanged` in `src/extension/extension.ts`) — the two events that
can each independently change what "signed in" or "accessible scopes" means.

### Scope selector (first panel)

One row per live scope for the active environment. **Click a row** to make
that scope the only accessible one immediately — no quick-pick, the row IS
the selection. The view's title bar carries a **checklist** icon that opens
the **Accessible scopes** pane (see below); it is the only title-bar action,
so the icon carries the meaning.

**Row order** (2026-09-08): accessible scopes first, alphabetical within,
then inaccessible scopes, alphabetical. The comparator is `sortScopeRows` in
`src/registry/scope-display.ts` — pure, and covered by
`test/registry/scope-order.test.mjs`. The **Accessible scopes** pane stays
purely alphabetical on purpose: a table row that jumps group as you tick it
cannot be used.

**Vocabulary** (PO, 2026-09-08): a scope is **Accessible** — the agent may
act in it — or **Inaccessible**. The words "locked" and "unlocked" are gone
from every string a person reads. They collided: "Saferoom is locked TO these
scopes" made the members the REACHABLE ones, while a row badge reading
`locked` was read as "shut out". The on-disk contract is unchanged —
`config.json` still stores `scopeLock: { mode, scopes }` with
`single|multi|unlocked`, and `scopeLock.scopes` **is** the accessible set.

The row icons carry the state. There are **three** of them, and they are
deliberately distinct in glyph, colour _and_ description:

| State                 | Glyph               | Description    | Meaning                                                       |
| --------------------- | ------------------- | -------------- | ------------------------------------------------------------- |
| Accessible            | green `pass-filled` | `accessible`   | the agent may act in this scope                               |
| Inaccessible          | `circle-slash`      | `inaccessible` | refused while this selection stands                           |
| All scopes accessible | yellow `globe`      | `accessible`   | `mode: "unlocked"` — every entitled scope, including new ones |

⚠️ **That distinctness is load-bearing for the absence of the confirmation.**
It did not hold when the confirmation was first removed: unlocked rows and
locked-elsewhere rows both rendered a neutral `circle-large-outline` with no
description, so the two were pixel-identical. The decision now lives in
`src/registry/scope-display.ts` (`scopeRowPresentation`) — a pure,
`vscode`-free function, precisely so that
`test/registry/scope-display.test.mjs` can assert the three stay
distinguishable. If you ever collapse two of them, restore the confirmation
in `switchers.ts` in the same change.

### Signed-in user

A **webview** pane (not a tree — 2026-09-03), because two of its controls
cannot be tree rows: an inline access-token form and an inline sign-out
confirmation.

Signed out, it is a single primary **Sign in** button. That is the default
route and there is nothing standing in front of it — no environment picker,
no menu of methods. Signed in, it shows the user (enriched by the backend's
`GET /api/v2/me` — a plain authenticated REST call, not an MCP tool), the
relative time to expiry, then **Data region** and **Expires** as labelled
rows, and a **Sign out** button.

**Trimmed 2026-09-10 (PO).** The card used to carry four rows: Identity
provider, Token ID, Data region, Expires. The first two are diagnostics, not
identity, and they crowded out the two facts that are — so they were removed
from the card and kept as a hover on the headline (and as rows in
**Settings ▸ Identity**, which is where you go looking for them). Two smaller
fixes landed with them:

- the relative expiry read **"expires expires in 4 h"**. `formatRelativeExpiry`
  already returns a complete phrase; the webview was prefixing a second
  "expires" onto it. The prefix is gone.
- **Expires** was already rendered in the host's locale and **local time
  zone** (`toLocaleString`), but named no zone, so it could be misread as UTC.
  It now stamps the short zone name — `9/10/2026, 6:35:07 PM EDT`. See
  `EXACT_EXPIRY_FORMAT` in `src/registry/credentials.ts`; every date/time
  component has to be listed explicitly there, because naming `timeZoneName`
  alone would suppress the implicit defaults and render the zone and nothing
  else.

> **Identity provider caveat**: `/api/v2/me` returns `{ email, displayName,
userId, profileImage }` today and does **not** yet include an identity
> provider, so that row is simply omitted for now. Saferoom already consumes
> an `identityProvider` field if the response grows one — delivering it needs
> a one-line backend addition (deriving the provider from
> `FmwebUser.username`, e.g. `google-oauth2|123` → `google`), tracked as a
> follow-up on the `fmweb-be` FMWEB-3068 branch.

The **Advanced: paste an access token** control used to sit here as a
collapsed disclosure. As of 2026-09-05 it lives in the **Settings** webview's
Identity section instead (PO: "advanced paste an access token form should be
exposed in the settings section via an advanced expansion (not in the sidebar
view)"), so this pane carries sign-in, sign-out and identity only. See
[§Settings ▸ Identity ▸ Advanced](#advanced-paste-an-access-token-settings--identity--advanced).

**When the stored credential has expired**, the pane leads with the recovery
instead of the identity: an inline `Session expired — Sign in again` strip
with a one-click button, and no modal. For a **token-only** environment
(sandbox has no CIMD client and therefore no sign-in to re-run) the button
reads `Open Settings › Advanced` and opens the access-token control, because
telling that user to sign in would be a dead end. The status bar mirrors the
state as a hint only — a `$(warning)` glyph, the warning background, and the
sentence in its tooltip — while the actionable prompt stays in the pane.

**Sign out has no confirmation** (PO, 2026-09-08: _"this one doesn't even
need confirmation. Just sign out when clicking sign out even if this means
destroying an M2M token."_). One click clears the stored token — and the
refresh token with it — from this machine's `credentials.json`. Nothing is
revoked anywhere: no endpoint is called.

The warning that survives is the **label**, chosen by credential kind
(`src/registry/credential-kind.ts`):

| Credential                | Button     | Tooltip                                                                 |
| ------------------------- | ---------- | ----------------------------------------------------------------------- |
| interactive sign-in       | `Sign out` | Signs out of \<region\> in this editor.                                 |
| pasted access token / M2M | `Remove`   | Removes the stored token from this editor; the token itself stays valid |

The kind is inferred, since nothing stores it: a token-only environment is
always `access-token`; a stored **refresh token** is the only positive
evidence of an interactive sign-in (only the OAuth grant writes one); and
anything else resolves to `access-token`. That asymmetry is deliberate —
calling a pasted M2M token's removal "Sign out" over-promises a revocation
that never happens, whereas calling a sign-in "Remove" is merely blunt.

The expiry values are derived from a **one-time** decode of the token's JWT
`exp` claim when the pane's state is built — they do not tick. The pane
re-reads on every refresh and after each of its own actions.

### Resources (launcher)

Four rows, always present:

- **FortMesa App** — opens the active environment's FortMesa app in your
  system browser (`fortmesa.openApp`): the environment's app host plus the
  app's own `/a/` path (prod → <https://fortmesa.com/a/>), derived per
  environment by `appLaunchUrl` so sandbox/next/latest each open their OWN
  host. All four app hosts are hardcoded (no detection) — `sandbox` is a per-developer `*.mesa.red` pod URL and needs
  **Cloudflare WARP** connected in your browser (the row's tooltip says so
  when sandbox is active); `next`/`latest`/`prod` are plain HTTPS.
- **Partner Portal** — <https://partner.fortmesa.com/> (environment-independent).
- **Knowledge & Support** — <https://partner.fortmesa.com/knowledge> (environment-independent).

All three web rows carry the **`link-external`** icon. They previously mixed
one semantic icon (`book`) with two external-link icons, which the PO read as
three different kinds of destination; they are in fact the same kind — each
one leaves the IDE for a browser. **Settings** keeps `settings-gear`
deliberately: it opens a webview inside the IDE and is not one of the three.

- **Settings** — opens the webview described in [§3a](#3a-settings-webview) below.

The two partner links open through VS Code's built-in `vscode.open` — they are
fixed URLs and do not need a command of their own.

### 3a. Settings (webview)

A hand-authored panel (**not** the embedded FortMesa app — it cannot be
iframed at all, `fmweb-be` sends `X-Frame-Options: DENY`) that is the
_complete superset_ of the native panels above, plus the functionality that
never got a native panel:

Every section is a **collapsible disclosure**, and they appear in this fixed
order (PO, 2026-09-08): **Agents · Tools · Data region · Identity · Scope**.
**Agents** and **Tools** are open by default; the other three start collapsed.
That is a deliberate reversal of the 2026-09-03 order, which led with the two
sections you cannot act on: Scope and Identity are mirrored **read-only** here,
their interactive surfaces being the sidebar and the Accessible scopes pane.

Each header is a real `<button>` with `aria-expanded` / `aria-controls`, so
Enter and Space both toggle it. Open/closed state is remembered **per machine**
(`globalState`, key `fortmesa.settings.sections`) — how a person works is not a
property of whichever repository happens to be open. The order and the defaults
live in `src/registry/settings-sections.ts`, a pure module, so
`test/registry/settings-sections.test.mjs` can assert them; a default buried in
a webview string literal is exactly how a wrong one ships unnoticed.

- **Data region** (renamed from "Environment") — a dropdown that contains
  **only Production (NA-US)** by default, with a live preview of that
  region's **Gateway** (MCP) and **App** (FE) URLs underneath it. Selecting a
  region **is** the switch — there is no Switch button. A **⚙ Advanced**
  toggle beside the dropdown reveals the three non-production environments:
  **Development Sandbox**, **Functional Testing (Next)** and **Quality
  Preview (Latest)**. It opens itself automatically when the active
  environment is already one of those, so the control can always show what is
  actually in effect.
- **Agents** — one row per IDE sync target, named for the agent (Claude Code,
  VS Code, Cursor, Codex, Antigravity, GitHub Copilot) with a checkbox and
  **two state chips**, always the same two questions in the same order:

  | Machine fact                                 | FortMesa fact  | Row reads                                     | Extra                                  |
  | :------------------------------------------- | :------------- | :-------------------------------------------- | :------------------------------------- |
  | found on this machine                        | wired in       | `Installed · Connected`                       | —                                      |
  | found on this machine                        | not wired in   | `Installed · Not connected`                   | inline **Connect** action              |
  | not found                                    | (not asked)    | `Not installed`                               | hint: `Install <Agent> to connect it`  |
  | the editor Saferoom runs in                  | wired in / not | `This editor · Connected` / `· Not connected` | Connect when not                       |
  | detection failed, or the host has no MCP API | —              | `Needs attention`                             | the cause, in the tooltip and the hint |

  Tooltips: `Installed` = "Found <Agent> on this machine"; `Connected` =
  "FortMesa is configured in <Agent>'s MCP settings". The labels are mapped
  in `src/registry/agent-status.ts` (pure, exhaustively unit tested) — the
  webview never invents a state name. This replaced free-text statuses of
  three different shapes (`detected`, `not detected on this machine`,
  `supported by this host`) that the PO could not tell apart. **Detection
  logic is unchanged**; only the labels are. ⚠️ The FortMesa chip reflects
  `ideSync.<target>` — what the sync pass projects — not a fresh read of the
  agent's own config file; no read-only "is our entry present" probe exists
  in `registry/projectors/**`. Toggling the checkbox (or **Connect**) saves
  `ideSync.<target>` and immediately re-syncs.

- **Tools** — a compact table (checkbox, tool name, description) for every
  tool the active environment advertises (the live `tools/list`); unchecked =
  disabled (`disabledTools`, W3 — see [§7a](#7a-the-tool-selector)).
  Descriptions are truncated with the full text available as a hover tooltip
  — tool descriptions are written for LLM consumption and can be long. The
  three `grc_documents_*` tools are **not** in this table; they have their
  own, below it.
- **Tools ▸ Documents** (new 2026-09-10) — a second table for the three
  documents tools, with a two-option switch above it. The three names are
  implemented on **both** sides of the proxy, and this is the control that
  decides which implementation your agents get:
  - **Local-file mode** (default) — the extension handles documents on this
    machine: agents read and write files by path in your workspace, and the
    extension uploads and downloads them through your signed-in session. The
    gateway's URL-based document tools are shadowed.
  - **Network mode** — the gateway's URL-based tools are exposed instead:
    agents receive signed upload and download links and move the bytes
    themselves. No workspace file access.

  The selected mode's paragraph is shown above the table, and the three rows
  are described **as that mode behaves** — the same name means something
  materially different in each. The switch is not cosmetic: it is persisted as
  `documentsMode` in `config.json` (the same store as the tool checkboxes),
  the running proxy picks it up through its config watcher, and the resulting
  `reload()` sends `notifications/tools/list_changed`, so a connected agent's
  tool list follows the switch without restarting anything. The per-tool
  checkboxes still work in both modes and are applied last. Decision logic:
  `src/registry/documents-mode.ts` (`mergeToolLists` for `tools/list`,
  `dispatchesLocally` for `tools/call` — both consumed by
  `src/local-mcp/proxy.ts`, so the advertised list and the routing cannot
  drift apart).

- **Scope** / **Identity** — read-only mirrors of the two native panels
  above, for at-a-glance status while you're already in the webview. The
  Identity mirror is a **table**, one labelled row per fact — Status, User,
  Email, User ID, Identity provider, Token ID, Data region, Token expires
  (absolute), Time remaining (relative) — rather than the single crammed
  sentence it used to be. Fields the best-effort `GET /api/v2/me` lookup
  cannot supply are omitted rather than rendered as "unknown".

The webview re-renders from a fresh state snapshot after every change you
make in it, AND whenever `config.json` changes externally (CLI, hand-edit)
while it's open — you never need to manually refresh it.

### Command Palette parity

Every real command above is also registered under the **FortMesa** category
(`Ctrl/Cmd+Shift+P` → type "FortMesa"): `Sign In`, `Choose Accessible Scopes…`,
`Sync Now`, `FortMesa App`, `Settings`, `Refresh`.

Three more palette entries were removed on **2026-09-03**, and each removal
is the point rather than a side effect: `Mint Fresh Token` (minting is gone
entirely — see below), `Paste API Token…` (pasting is an inline advanced
control in the Signed-in user pane, not a palette prompt), and `Sign Out`
(it needs the pane's inline confirmation, which a palette entry cannot
show).

Four palette entries were **removed** on 2026-09-03 because each opened a
quick-pick detached from the click that summoned it, and each was fully
covered by a pane: `Switch Environment…` (→ Settings ▸ Data region), `Switch
Scope…` (→ Scope selector rows), `Toggle IDE Sync…` (→ Settings ▸ Agents),
and the Identity `+` picker `fortmesa.identityAddMenu`. The Signed-in user
view's title-bar action is now **Sign In**. `Sync Now` stays palette-only (U2/W9) — auto-sync
on activation and on any `ideSync.*` change already covers the common case.
`Refresh` re-runs every panel's live read (including the Scope selector's live
gateway fetch).

## 4. Signing in

### Advanced: paste an access token (Settings ▸ Identity ▸ Advanced)

Pick the data region (the active one is preselected; the list exists so you
can seed credentials for a region that is **not** active), paste the token
into the masked field, press **Save access token**. Before saving anything,
Saferoom:

1. Decodes the JWT and rejects the paste outright if it can't find an `exp`
   claim (not saved — the panel says why).
2. Makes a live test call (`grc_scopes list`) against that region's gateway
   with the pasted token, and rejects it with the gateway's reason if that
   call fails.

Only after both checks pass does it write the token into that env's block in
`credentials.json` (preserving any existing `scopeMap`/base URL). If the
region has no existing credentials block, the panel reveals an **API base
URL** field and asks you to submit again — still inline, never a popup.

The **Create an access token →** link opens
`<app>/a/accountProfile#createToken` for the **selected** region (the one in
the dropdown directly above it, not the active one). The `/a/` segment is the
FortMesa app's root slug — every environment serves the FE application there,
and the bare host is the marketing site. Through 0.7.7 this link omitted it and
landed nowhere; it is now derived from the same `appLaunchUrl()` builder the
**FortMesa App** launcher and the sign-in start/completion pages use, so the
four cannot drift apart again.

> ⚠️ **Known gap**: fmweb-fe does not handle the `#createToken` fragment yet.
> Today the link lands on the account profile with the token modal closed.
> The link is written in its final shape on purpose, so nothing here changes
> when the FE catches up.

### Saving a token makes that region usable (0.7.8)

Two files decide what you see: **`credentials.json`** holds a token per
region, and **`config.json`'s `activeEnv`** decides which region every surface
reads. Through 0.7.7 saving a token wrote the first and never the second, so
pasting a Next token while Production was active left the Next credential on
disk and invisible — the panel confirmed the save one line above
`Not signed in · Production (NA-US)`, and the Tools list reported
`No credentials available for env 'prod'`.

Now:

- **The Data region section lists every region it is offering with a
  credential chip** — `Signed in`, `Token saved`, `Session expired`, or
  `Not signed in` — plus an `Active` chip on the one in effect. It remains the
  one place the active region is switched, atomically on selection.
- **Saving a token for a region whose active region has nothing usable
  switches to it**, and says so: `Switched to Functional Testing (Next).`
  "Nothing usable" means no token, or a provably expired one.
- **If the active region still holds a live credential, nothing moves.** You
  get a one-click **Switch to \<region\>** offer beside the save
  confirmation instead. Seeding a Next token while signed in to Production
  must never silently re-point your tool calls at another tenant.
- **Sign in (OAuth) always targets the active region** — unchanged, and the
  Data region control is how you change what that is.

### Minting was removed (2026-09-03)

`Mint Fresh Token` / `fmmcp-local token mint` and their shared
`mintTokenViaApi` helper are **gone**. Mint rotated an existing token via
`POST <api-base>/api/iv2/createNewJwtToken`; it could never create one from
nothing, so all it bought was skipping a trip to the web UI on the
discouraged path — i.e. it lowered resistance to the lower-security method.
Rotate a token in the FortMesa web UI instead, or sign in.

### Sign Out

Clears the stored token for the active environment (after the pane's
**inline** confirmation — never a modal) but **keeps** the API base URL and any cached `scopeMap` on that
env's block, so a later paste or sign-in doesn't need to re-supply them.

> **Note**: the Signed-in user pane re-reads its own state after each of its
> own actions (sign in, sign out, saving a token), so it no longer goes stale
> behind a toast. The _other_ panels still only re-read live state when
> `config.json` itself changes (which switching environment/scope does
> automatically) or when you run **FortMesa: Refresh** — the Settings
> webview's Scope/Identity mirrors included.

## 5. OAuth Sign In — the dedicated sign-in page

`FortMesa: Sign In` (palette, Identity pane **[Sign in]**, and the expired-session
notice's action) all open one webview page (`fortmesa.signIn`) — there is no
native input box or quick pick anywhere on this path. **Both sign-in methods
are on the page at once and always visible**, Claude Code-style:

- **A · Automatic browser flow** — _"Needs a local port this editor can listen
  on."_ A PKCE Authorization Code flow over a forwarded loopback callback
  (`vscode.env.asExternalUri`). Works locally and over Remote-SSH when the
  browser can reach the forwarded port.
- **B · Code-based sign-in** — _"You copy a code from the browser."_ After
  signing in, paste either the full redirect URL (`?code=…&state=…`) or the
  `code#state` string a hosted page shows. A **bare code is refused** ("Paste
  the whole code — it has two parts joined by #") because `state` cannot be
  verified on that shape alone; `state` is checked on every other path.

The extension **pre-selects** one method from the detected topology (a
loopback-forwardable host picks A; anything else, including a browser-only
`uiKind`, picks B) and **remembers the last method that worked on this
machine**, keyed by `vscode.env.remoteName`.

**The two cards are a `role="radiogroup"`, and the whole card is the control.**
Neither is dimmed, neither is `aria-disabled`, and there is no "Use this
instead" link: click either card, or move between them with the arrow keys
(which move _and_ select, per the WAI-ARIA radio pattern) and confirm with
Space or Enter. The selected card is outlined in the theme's focus colour and
carries a check mark.

**Every action lives inside the card it belongs to.** There is no button row
under the chooser — an unselected card is a title and a requirement, and
selecting a card can only grow _that_ card:

- **A · Automatic browser flow**, selected, holds one primary button —
  **[Continue as \<name\>]**, or **[Sign in]** with no cached identity — which
  starts the browser flow.
- **B · Code-based sign-in**, selected, holds a one-line **read-only field
  showing the exact authorize URL**, a **copy icon** beside it (which flips to
  a check for ~1.5 s), and the paste box. The URL is shown, not just copied,
  because a copy button can fail silently and the user then has no way to see
  what they were meant to have; the field selects itself on focus or click so
  Ctrl+C works. That URL is an authorization _request_ — `client_id`, `state`,
  the PKCE **challenge**, the redirect URI — and never carries a code, a token
  or the verifier.
- **Selecting card B prepares the session** so the URL is real. It does **not**
  open a browser: picking a method is not a request to launch anything.
- The paste box's **[Paste code]** button appears only once the box is
  non-empty, and **Enter submits**.

**The page never explains its own choice.** The pre-selection is a courtesy,
not a claim, so no "Chosen because …" line exists — the earlier one was also
mis-mapped, rendering the _browser_ method's justification on the paste card
whenever the user swapped. Each card states only its one real requirement.

**The waiting screen replaces the chooser** rather than appearing above it.
Its only chrome is a **back arrow in the headline** (`aria-label` "Back",
tooltip "Cancel and choose another way"), which cancels the attempt and returns
to the landing with the previous selection kept. There is no Cancel button, no
"Open browser again" (back, then start again, does the same thing) and no
"Copy link" button — the copy icon beside the URL is the copy control.

Below a divider the waiting screen carries the **same fallback as card B** —
the read-only URL, the copy icon and the paste box — introduced with _"If the
browser shows a code or an address instead, paste it here."_ The paste path
stays live underneath the running browser flow with no mode switch and no
restart, so a browser that ends up on a page it can't reach is still a finished
sign-in.

**Identity landing**: if this machine has signed in before, the landing shows
an identity row **above** the cards — initials avatar, name, and
`email · region` — with a **[Use a different account]** text button. The
selected card's own primary button is **[Continue as \<name\>]**, which starts
the selected method with a `login_hint`; **[Use a different account]** starts
the _same_ selected method with `prompt=login`, forcing Auth0 to show the login
form instead of silently reusing the SSO session. On card B that means the link
field re-prepares with the new intent rather than opening anything. The cached
identity comes from `fortmesa_last_identity` in `credentials.json`, written on
every successful sign-in. Signing in as a different account than the one you continued as
lands on a **wrong-account** screen with **[Continue as \<actual\>]** /
**[Sign in as \<intended\>]** — no second sign-in needed to keep the one that
actually landed.

**When a sign-in fails**, the page says so in the user's terms — _"The sign-in
timed out — nothing came back from your browser."_ — rather than printing the
underlying exception. The transport tags every failure with a `kind`
(`timeout`, `no-api-base`, `not-configured`, `provider-refused`,
`exchange-failed`, `state-mismatch`, `bad-paste`, `unknown`) and the page maps
that to copy. Only the two kinds with nothing better to say
(`provider-refused`, `exchange-failed`/`unknown`) also show the raw message, as
a muted detail line — which is what makes the web page's promise _"Go back to
your editor — it shows the details"_ true. Each terminal state offers exactly
one next action (**Done**, **Try again**), with the sole exception of the
wrong-account screen, which is a genuine fork rather than a retry and keeps
both **[Continue as \<actual\>]** and **[Sign in as \<intended\>]**.

**"You're all set" page**: method A's flow ends with a 302 to
`<app>/a/auth/saferoom/complete?outcome=ok|cancelled|error&env=<env>` in your
browser — a small FortMesa web page confirming who you're signed in as and
that you can close the tab. This is a 302 _target_, not an OAuth
`redirect_uri` — Auth0 never sees it, so it needed no CIMD change.

**The hosted code page — LIVE as of 2026-09-09** for production, Next and
Latest. Method B's browser leg now ends on `<app>/a/auth/saferoom/callback`,
a FortMesa page that shows `code#state` with a **[Copy]** button, instead of
on the browser's own "can't be reached" error page with the code sitting in
the address bar. The switch is one data field per environment
(`hostedCallback` in `src/registry/environments.ts`) and it was gated on
evidence, not on the page existing: each environment's CIMD document must
list that `redirect_uri` **and** Auth0's stored client record must have been
refreshed to match, because presenting an unlisted `redirect_uri` gets the
whole sign-in rejected. Both were verified per environment by an anonymous
`GET https://auth.fortmesa.com/authorize?…` returning **302** to the login
page, with an unlisted sibling path on the same client returning **403
"Callback URL mismatch"** as the control. The **sandbox** environment has no
CIMD client and no OAuth sign-in at all, so it has no hosted callback and
never will. See **`.agent/DECISIONS.md` D019** and
`docs/saferoom-client-metadata.README.md`.

**Landing on FortMesa first (production).** Before the browser reaches Auth0,
production sign-ins now land on `https://fortmesa.com/a/auth/saferoom/start`
— a FortMesa page that says which account you are about to use and forwards
to Auth0 only when you click (**Continue as \<name\>**, or **Use a different
account**, which adds `prompt=login`). The extension passes that page the
authorize request's **parameters**, never a URL: `client_id`, `redirect_uri`,
`code_challenge`, `code_challenge_method`, `state`, `resource`, `scope`, and
`prompt`/`login_hint` when the intent carried them. The web app holds the
Auth0 issuer as its own compiled constant, so the page cannot be turned into
an open redirector by anything in the query string.

Two things deliberately do **not** change: the `redirect_uri` (so no CIMD or
Auth0 record is involved — this is why the start page could ship
independently of the change above), and the sign-in page's **read-only "copy
the link" field**, which still hands out the real Auth0 authorize URL. That
link exists for the user finishing in a _different_ browser, where there is
no FortMesa session for the start page to show an identity from. The
per-environment switch is `firstLandPage` in
`src/registry/environments.ts`, **on for production only** — Next and Latest
turn on once their fmweb-fe builds route `auth/saferoom/start`. If the
authorize request is ever malformed, or somehow carries a credential, the
extension silently opens Auth0 directly rather than the start page: sign-in
still works, you just do not get the identity screen.

## 6. Switching environment and scope

All four actions below only ever write to `~/.fmcode/config.json` — they
never talk to a running local MCP instance directly, and they never touch any IDE's own
config file (Claude Code's `~/.claude.json`, Cursor's `mcp.json`, etc. stay
byte-for-byte unchanged). Every local MCP instance any agent has spawned watches
that file and hot-reloads on change: it tears down its gateway connection,
re-resolves credentials for the new environment, rebuilds the scope lock, and
sends `notifications/tools/list_changed` — all without dropping the stdio
pipe to the agent. In-flight tool calls either complete or fail with a clear
"environment switched mid-call" error; nothing needs to be restarted for this
part.

### Switching environment

The **Settings** webview's Environment dropdown (preview its Gateway/App
URLs, then **Switch**) or the command-palette-only **Switch Environment…**
quick-pick let you pick among the environment names already defined in
`config.json` (active one sorted first in the quick-pick). Picking a
different one updates `activeEnv` and every live local MCP instance
re-targets its gateway on the next reload cycle. Note: this only lets you
_choose among_ already-configured environments — there's still no Saferoom
command to add a new one or edit a gateway URL; that requires hand-editing
`config.json` or the `fortmesa.environments` JSON setting (see
[docs/CONFIG-REFERENCE.md](CONFIG-REFERENCE.md)).

### Scope selector row click (primary workflow)

The **Scope selector** panel lists every scope the active environment's gateway
reports (a live `grc_scopes` fetch, using your stored credentials — sign in
first if you haven't). **Click a row** to set
`scopeLock: { mode: "single", scopes: ["<name>"] }` immediately — Saferoom
will then refuse calls outside that one scope and filter it out of
scope-listing results too. (The status bar reveals this view rather than
opening a picker.)

### Choose Accessible Scopes… (Scope selector ☑ title action)

Opens the **Accessible scopes** pane in the editor area
(`src/extension/scope-select-panel.ts`) — same live scope fetch, rendered as a
**mode toggle above a table**. Rebuilt 2026-09-08 (PO: _"the multi-select
select all box is confusing … can we redesign this to a tabular multi-select
more familiar to the user with headline bulk-select/unselect control?"_) and
again the same day, after testing 0.7.4 (PO: _"we need to avoid the apply
button which may be scrolled offscreen … I think we should auto-apply but
perhaps adopt a sync approach. Similar to google's undo button"_).

#### The mode toggle

A two-option radiogroup at the top of the pane, with one hint line under it:

| Option              | Hint                                                                             | Table  |
| :------------------ | :------------------------------------------------------------------------------- | :----- |
| **Selected scopes** | The agent can act only in the scopes you check.                                  | shown  |
| **Run unlocked**    | The agent can act in every scope you have access to, including ones added later. | hidden |

It defaults to whatever is saved: `single`/`multi` → **Selected scopes**,
`unlocked` → **Run unlocked**. Arrow keys move within the group (it is one tab
stop, roving `tabindex`). In **Run unlocked** the table is **hidden, not
disabled** — a greyed-out grid of forty checkboxes is a wall of noise stating
something the hint line says better — and the count line reads
`All scopes accessible`.

Switching to **Run unlocked** **keeps** the named scopes in
`scopeLock.scopes`. They are ignored while `mode` is `"unlocked"` (and
`scope-display.ts` is explicitly hardened for a stale array), so keeping them
costs nothing and makes the round trip back to **Selected scopes** lossless.

#### Auto-apply, and the sync affordance

**There is no Apply button and no Cancel.** Every change — a row checkbox, a
shift-click range, the header tri-state box, `Select all`, `Clear`, or the mode
toggle — writes by itself after a **2 second** debounce. A sync affordance sits
at the right of the headline row, next to the filter box:

| Phase                          | Reads              | Action    |
| :----------------------------- | :----------------- | :-------- |
| a change is pending or writing | `Applying…`        | **Undo**  |
| it landed                      | `Saved`            | **Undo**  |
| it did not                     | `Couldn't save`    | **Retry** |
| nothing outstanding            | _(no space taken)_ | —         |

- **Storms are impossible by construction.** Every edit re-arms the single
  debounce timer, so twenty rapid clicks coalesce into **one** write, and at
  most one write is ever in flight.
- **A click is never lost.** An edit made while a write is out does **not**
  cancel that write — those bytes are already on their way — it returns the
  machine to `Applying…` and re-arms the timer, so the final draft always
  reaches disk. A failed write **keeps your draft** and offers `Retry`; it
  never silently reverts.
- **Undo is Google-style**: it reverts the whole coalesced change (not the last
  click) to what was saved when the burst began, and writes that, because by
  then the old value is no longer on disk. It is offered for the whole
  pending + writing + `Saved` window (~4 s) and then retires with the burst.
- **Why 2 s**: the cost being amortised is not the file write, it is the hot
  reload it triggers — three views refreshed, the MCP provider's change event
  re-fired, every running proxy re-reading its scope lock. 2 s is above a
  human's inter-click cadence inside one intent burst and below the point at
  which a surface feels unresponsive. We do not buy safety with a longer delay
  because Undo, not the wait, is the safety net.

The machine is `src/registry/scope-sync.ts` — pure, and **driven** (not
source-read) by `test/registry/scope-sync.test.mjs`, which asserts the storm and
lost-click properties directly.

#### The table

- **Columns**: checkbox · `Scope` · `Scope ID` · `State`.
  There is **no organisation column**: `grc_scopes list` passes through
  `GET /api/v2/scopes`, whose response carries `id`, `name`, `planActive`,
  timestamps and three opaque user ids — no organisation display name. The
  scope's `name` **is** the organisation name in this product, so an Org column
  would be empty or a duplicate, and filling it would need another call.
- **The checkbox shows your draft; the State cell and the count show what is
  SAVED.** That split is the honesty of an auto-apply surface: the click is
  answered instantly, but `n of N accessible` and `Accessible` /
  `Inaccessible` describe what the agent can do _right now_. A row whose write
  is outstanding reads `Applying…` — and only while the affordance above says
  the same thing.
- **Headline bulk control** — a tri-state checkbox in the header row
  (none / some / all) plus a `Select all` · `Clear` text pair.
- **Filter box** when there are more than 12 scopes. Bulk actions and the
  header checkbox act on the **visible** rows only; the count stays about the
  whole selection. **Typing in the filter never schedules a write.**
- **Keyboard**: space toggles the focused row (native checkbox), shift-click
  extends from the last row touched.
- **Zero accessible scopes is a valid saved state** (PO: _"its not even
  possible to apply to zero scopes right now …. and it should be"_). Nothing
  blocks it. It persists as `mode: "multi"` with `scopes: []`, and it fails
  **closed**: every scope is refused, and the sidebar says so. Exactly one
  scope still persists as `mode: "single"`.
- Opened while `mode` is `"unlocked"`, every row starts ticked — under that
  mode every scope really _is_ accessible.

The projection is `projectScopeTable` in `src/registry/scope-table.ts`, a pure
function; the webview is a dumb renderer that posts its draft to the host and
renders what comes back. That is why every table state is assertable in
`test/registry/scope-table.test.mjs` — and why the round-3 defect (a summary
reading `N of N scope(s) locked` when all N were **accessible**) could ship: the
same logic used to live inside a webview string literal that no test could reach.

#### The pane follows the identity

Signing in, signing out, pasting an access token or picking a different account
now **reloads** the pane and says so (`Signed in as <name> — scopes reloaded`),
and abandons any burst in progress: the scopes it named belonged to someone
else.

That did not happen before (PO: _"When auth state changes (new session
selected …) scope selector is no longer valid but state is not refreshed"_).
The reason was structural: the one refresh fan-out that reaches the scope
surfaces is driven by a watcher on **config.json**, while all four of those
actions write **credentials.json**, which nothing watches — deliberately, since
it holds bearer tokens and a silent token refresh is not an identity change.
The signal is now `src/registry/identity-events.ts`, fired by every site that
mutates credentials and consumed by `extension.ts` and the pane itself.

### Unlock (All Scopes) — REMOVED 2026-09-08

The Scope selector's overflow action is gone (PO: _"unlock all primary side bar
action may be removed (we have a select all option inside the multi-select
screen)"_). Note what that trades away, because it is not an exact
equivalence: `mode: "unlocked"` meant "every scope this account is entitled to,
**including scopes granted later**", while `Select all` is a snapshot of the
scopes that existed when it was pressed. A scope granted afterwards will be
inaccessible until the user selects it.

`mode: "unlocked"` remains a valid config state — set by hand in `config.json`,
by the `fortmesa.scopeLock.mode` setting, or by `fmmcp-local switch --unlock` —
and is still fully rendered (yellow `globe` rows, `all scopes` in the status
bar). There is simply no longer a button that sets it.

## 7. IDE sync behavior

| Target                               | How `fortmesa` gets registered                                                                                                                                                                                                                                                    | Env/scope switch pick-up                                                                                                                                                                        | New sync / opt-out pick-up                                                                                          |
| :----------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------ |
| **VS Code** (this extension, native) | `vscode.lm.registerMcpServerDefinitionProvider`, only if the host actually implements it (real VS Code ~1.102+; some forks don't — checked at activation, logged to the Output channel)                                                                                           | **Live** — nothing to re-register (the server spec is a fixed `launch-mcp.sh`, no args); the change happens entirely inside the already-running local MCP process via its own config.json watch | **Live** — registered as soon as the extension is active                                                            |
| **Claude Code**                      | `claude mcp add-json fortmesa ... --scope user` if the `claude` CLI is on PATH, else a surgical merge of `mcpServers.fortmesa` into `~/.claude.json`                                                                                                                              | Live within Claude's own spawned local MCP process, same hot-reload as above                                                                                                                    | Restart your Claude Code session                                                                                    |
| **Cursor**                           | File-only today: surgical merge of `mcpServers.fortmesa` into `~/.cursor/mcp.json`. (Cursor's own proprietary live-registration API, `vscode.cursor.mcp.registerServer`, is _detected_ at activation and logged, but this build does not yet call it — see the limitation below.) | Live within Cursor's own spawned local MCP process                                                                                                                                              | Open Cursor's MCP settings panel and click Refresh, or restart Cursor                                               |
| **Codex**                            | `codex mcp add fortmesa -- <path>/launch-mcp.sh` if the `codex` CLI is on PATH, else a TOML-aware merge of `[mcp_servers.fortmesa]` into `~/.codex/config.toml`                                                                                                                   | Live within Codex's own spawned local MCP process                                                                                                                                               | Next Codex invocation                                                                                               |
| **Antigravity**                      | Surgical merge of `mcpServers.fortmesa` into `~/.gemini/config/mcp_config.json`; opt-out sets that entry's own `"disabled": true` rather than deleting it                                                                                                                         | Live within Antigravity's own spawned local MCP process                                                                                                                                         | No hot-apply for config-file edits — hit Installed-MCP-Servers Refresh, run a `/mcp` reload, or restart Antigravity |

**How sync actually runs today**: the projection engine above
(`src/registry/sync.ts` + `src/registry/projectors/*`) is fully implemented
and reachable from both the CLI and the Saferoom panel:

```bash
yarn node dist/local-mcp/cli.js sync
```

The command-palette-only **Sync Now** runs the same engine and shows the
same per-target report (added/updated/skipped/disabled) in an information
message and the Output channel. The **Settings** webview's Agents checkboxes
(each shown alongside `Installed`/`Not installed`/`This editor` and
`Connected`/`Not connected` chips — see §Settings) — or the
command-palette **Toggle IDE Sync…** quick-pick — flip a target's
`ideSync.<target>` flag (reconciled into `config.json` automatically) and
immediately run a sync pass so the opt-out/opt-in takes effect right away —
no need to also run Sync Now afterward. Auto-sync
already covers activation and any `ideSync.*` change by any path (the
setting, `config.json`, the webview, or the CLI) — Sync Now survives only as
a manual recovery command (U2/W9), not a required step. Sync deliberately
does **not** re-run on every environment/scope switch, since the projected
IDE config files are byte-stable across those and need no re-projection.

**`fortmesa.ideSync.vscode` is honored**: `mcp-provider.ts` returns no server
definition when the flag is off (and fires the provider's change event when
it flips), so toggling it actually turns VS Code's own live MCP registration
on and off, the same as the four file-based targets above.

## 7a. The tool selector

New this round (W3): the **Settings** webview's **Tools** section lists
every tool the active environment advertises (the live `tools/list` plus the
three local documents tools) as a table row (checkbox, name, description —
tool descriptions are written for LLM consumption and can run long, so
they're truncated with the full text as a hover tooltip). Unchecking one
adds its name to `disabledTools` in `config.json`; every running local MCP
instance re-reads that list live (the same hot-reload mechanism as the
scope lock):

- The disabled tool disappears from `tools/list` for every connected agent
  (a `notifications/tools/list_changed` fires, same as an env/scope switch).
- A stale or direct call naming a disabled tool gets a clear
  `isError: "tool '<name>' is disabled in Saferoom settings"` instead of
  running.
- This is **global**, not per-environment — disabling a tool applies no
  matter which environment is active. All 16 tools are enabled by default.

## 8. Troubleshooting

### Tools don't appear (or don't change) after switching environment or scope

- Give the hot-reload a moment — check the Output channel (or the client's
  own MCP log) for a `notifications/tools/list_changed` line; the switch
  itself is near-instant but the client may take a beat to re-fetch.
- Some clients cache the tool list until _their own_ refresh action —
  check the pick-up column in the table above for your IDE.
- Confirm the switch actually landed: run **FortMesa: Refresh** (or
  `fmmcp-local status` from a terminal) and check `scopeLock`/`activeEnv`
  match what you expect.
- If you just switched scope, confirm the scope you picked actually has
  tools/data behind it for the current environment — an empty-looking scope
  isn't necessarily a bug.

### An IDE isn't picking up a config change (or never got registered at all)

- If it's one of the four file-based targets (Claude Code, Cursor, Codex,
  Antigravity): run **Sync Now** from the Command Palette (or `fmmcp-local
sync` from a terminal — see [§7](#7-ide-sync-behavior)) and read its
  per-target report.
- Check `fortmesa.ideSync.<target>` (or `config.json`'s `ideSync` map) isn't
  set to `false` for that target.
- Check the target is actually _detected_ — `sync` only writes into a config
  file for a target it can find (its CLI on PATH, or its config directory
  already existing). It never creates a target from nothing.
- Antigravity in particular never hot-applies file edits — you must
  Refresh/`/mcp` reload or restart it even after a successful sync.
- For VS Code itself: confirm the host actually implements
  `vscode.lm.registerMcpServerDefinitionProvider` — check the activation log
  line in the Output channel (`hasLmMcpProvider=...`). Some VS Code forks
  don't implement it; that host needs the file-based projector path instead
  (not currently wired for VS Code, since it's the one target the plan
  always treats as API-only).

### A pasted token is rejected

- **Pasting a token** validates before saving — if it's rejected, nothing was
  written, so re-check the token rather than assuming a partial save.
- Make sure it's a FortMesa **API (M2M)** token, not a browser session
  token — the v2 API rejects the latter outright.
- Make sure you're pasting it for the **right environment** — a sandbox
  token pasted while targeting `next` will fail the live probe against
  `next`'s gateway.
- Check expiry — a token whose `exp` has already passed decodes fine but
  will fail the live gateway probe.
- If a token was rejected as a slow hang rather than a fast error, that's a
  known upstream characteristic of a stale/orphaned token on the backend
  side (not something this extension can detect faster) — treat it the same
  as "invalid/expired, re-authenticate."

### A pasted code is refused

The paste field only accepts the full redirect URL or the `code#state` string
a hosted page shows — a bare code alone is refused because its `state` can't
be verified. Copy the whole address (or the whole `code#state` value) and
paste that. See [§5](#5-oauth-sign-in--the-dedicated-sign-in-page).

## 9. Known limitations in this build

Summarized from the sections above, for a single at-a-glance list:

1. **Cursor's live registration API is detected but not used** — Cursor
   sync is file-only (`~/.cursor/mcp.json`) in this build, requiring its own
   MCP-settings refresh even though the underlying API could, in principle,
   make it live.
2. **The `environments` map has no add/edit UX** — the Environment dropdown
   (webview) and **Switch Environment…** only select among already-configured
   entries; adding a new environment or changing a gateway URL still requires
   hand-editing `config.json` or the `fortmesa.environments` setting (see
   [docs/CONFIG-REFERENCE.md](CONFIG-REFERENCE.md)).
3. **The FortMesa first-land page is production-only, and both hosted pages
   are fmweb-fe deploys this extension cannot verify from inside itself** —
   `firstLandPage` is set for production alone; Next and Latest keep going
   straight to Auth0 until their fmweb-fe builds route
   `auth/saferoom/start`. Turning either page on for an environment whose web
   app does not yet serve the route strands the user on the app shell, so
   these two flags track a **deploy**, not a capability, and a rebuild of the
   VSIX must re-confirm the routes are live (see
   [§5](#5-oauth-sign-in--the-dedicated-sign-in-page), `.agent/DECISIONS.md`
   D019). The hosted _callback_ page itself is live on all three
   environments as of 2026-09-09.
4. **Scope status doesn't auto-refresh after every action** — only a
   `config.json` change (switching env/scope) or an explicit **Refresh**
   updates the Scope/Resources panels and the Settings webview's read-only
   mirrors. (The Signed-in user pane refreshes itself.)
5. **No Saferoom control adds/edits an environment**, and **no control
   surfaces `logLevel`** — see
   [docs/CONFIG-REFERENCE.md § Known gaps](CONFIG-REFERENCE.md#known-gaps-as-built)
   for the full, authoritative list of settings without a matching UI control.
6. **The expiry shown in the Signed-in user pane does not tick** — both the
   relative description and the exact tooltip stamp are computed when the row
   is built and only change on a refresh.
7. **The tool selector (§7a) is global, not per-environment** — disabling a
   tool applies regardless of which environment is active (D-U4, by design
   for this prototype round).
8. **Prod scope-branding is parked** — a child-scope-under-parent's own
   branded app domain (`BrandAsset.brandURLDomain`, e.g. `vciso.app`) is not
   surfaced anywhere; **FortMesa App** always opens the flat per-environment URL
   from `src/registry/environments.ts`.

None of these block the core loop (sign in, pick an environment, lock a
scope, have your agent's tool calls enforced against it) — they're all either
a CLI-only workaround away or explicitly gated on separate, tracked work.

## Related docs

- [README.md](../README.md) — the CLI (`fmmcp-local`), for the same
  functionality from a terminal.
- [docs/CONFIG-REFERENCE.md](CONFIG-REFERENCE.md) — the full `config.json`
  key ↔ VS Code setting ↔ CLI command ↔ Saferoom UI control matrix, including
  every D-V8 gap in more detail than [§9](#9-known-limitations-in-this-build)
  above.
- [SECURITY.md](../SECURITY.md) — credential storage and transport security
  model (why tokens live only in `~/.fmcode/credentials.json`, never in VS
  Code settings).
- `.agent/planning/VSIX-PLAN.md` — the full design (architecture, decisions
  D-V1–D-V10, the OAuth backend ticket in §8, the post-prototype backlog in
  §9).
