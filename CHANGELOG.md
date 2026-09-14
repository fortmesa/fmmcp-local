# Changelog

## [2026-09-14T17:01:25Z] Release: feat/MFDV-246-saferoom-0.8.0

- User: Matthew Fisch + Claude Fable 5.1 (MFDV-246, MFDV-489, FMENG-3097)
- Version: 0.8.0
- Commit: (this commit)

### What's New

#### See what your agent is doing, while it does it

Saferoom sits between your agent and FortMesa, and until now that was an opaque place. An agent
would work for a minute and you had no way to tell whether it was reading controls, uploading a
document, waiting on the gateway, or quietly failing on an expired token.

The **Event viewer** is a live timeline of exactly that, at the top of the FortMesa sidebar. Every
MCP tool call the local server handles appears the moment it starts and updates in place when it
finishes:

```
●  documents · upload_url                    now
✓  controls · read              84ms       now
✕  documents · download    401 expired  1.2s   3m ago
↻  auth · refresh                       12m ago
```

Both the local documents tools and calls relayed to the cloud gateway are included — they are hooked
at the **single dispatch point** every call passes through, so a tool cannot be added later that
quietly bypasses the timeline. Session events are there too: sign-in, sign-out, token refresh, token
expiry, and gateway connect/disconnect/reconnect.

The **expand icon** in the pane's title bar opens a fullscreen view in the editor area with the last
200 events and two extra columns — which **scope** the call was made in, and whether it was served
**locally** or **relayed** to the gateway. The sidebar keeps the most recent 30. Both stream live off
the same buffer.

#### What it deliberately does not show

The timeline carries the **tool family and method, the scope, the outcome, and the duration**. It
does not carry request or response payloads, file paths, document titles, email addresses, tokens,
or raw error messages — and not because those are stripped before display. They are never collected.
The summary is built by reading a fixed allowlist of fields off each call, so an argument nobody
anticipated has no route into the pane even in principle. Failures are reduced to a closed set of
classes (`401 expired`, `403 denied`, `4xx`, `5xx`, `timeout`, `network`, `blocked`) because a
gateway error message can quote the request that produced it.

**Nothing is persisted.** The buffer is a plain object in the extension host, built fresh on every
activation. There is no file, no `globalState`, no cache. Reloading the window or closing the editor
leaves nothing behind — the events the proxy sends travel over a local, owner-only socket that holds
no data at rest, and if nothing is listening they are dropped rather than queued.

There are no filters, no search, no export and no log stream today. The subscription seam a log
stream would attach to (`EventBus.subscribe`) is in place, but turning this pane into a log viewer
is a decision someone should make on purpose.

#### Point Saferoom at the FortMesa that is yours

Saferoom talks to FortMesa production out of the box, and until now that was the only thing it
could talk to unless you hand-edited `config.json` — which nobody does. **Data region** now has an
**Add server** button: name the server, give it a gateway URL, and select it like any other. A
server you add yourself stays available in production builds, while a stale `next` or `latest`
entry left behind by an older dev install is still refused.

#### Your agent's tools stay put when the gateway blips

The tool list used to be fetched from the gateway on every single request, so a momentary network
problem meant your agent saw **no tools at all** rather than the ones it had a second earlier.
Saferoom now keeps the last list it was given and serves that while a refresh is failing, and
refreshes on a short cycle otherwise. Switching environment, scope, or sign-in still throws the
list away immediately, so the tools you can see always match the account and gateway you are
actually pointed at.

#### Uploads keep the name you give them

Uploading a document used to store it under whatever the file happened to be called on your disk.
Pass a `fileName` and Saferoom now stores it under that name — which also decides whether the
upload becomes a new document or a new version of an existing one, since the server de-duplicates
by stored filename. Omit it and nothing changes: the local basename is still used.

### Developer Notes

- **New**: `src/registry/events/**` (`event-bus`, `event-record`, `event-row`, `event-sink`,
  `summarize`, `transport`), `src/local-mcp/{event-client,tool-events,auth-events}.ts`,
  `src/extension/events-view.ts` — the Event viewer, hooked at the single dispatch point in
  `proxy.ts` so no future tool can bypass the timeline.
- **New**: `src/local-mcp/tool-schema-cache.ts` — TTL cache over `tools/list` with
  serve-last-good-on-failure, a `_meta` (`fortmesa/schemaExpiresAt`) gateway-published expiry
  override, and single-flight collapse of concurrent misses. Invalidated by `proxy.ts` `reload()`.
  This is what makes deriving schemas from the gateway (FMENG-3097) affordable — the extension no
  longer carries its own copies, which used to freeze on the day the VSIX shipped.
- **New**: `src/registry/custom-servers.ts` — user-added environments as `custom: true` entries in
  the `environments` map; the marker is what lets a prod-only build accept a deliberately added
  server while still refusing a leftover `next`. `vscode`-free and unit-tested.
- **Changed**: `src/local-mcp/tools/documents.ts` — `fileName` now overrides the local basename on
  local upload (MFDV-489), with a plain-name guard rejecting `/` and `\`; default behaviour
  unchanged. `src/shared/scope-lock.ts` gained a read-only `nameFor()` used by event summarisation
  (no enforcement change). `.github/workflows/release.yml` and `bitbucket-pipelines.yml` now build
  and publish the GitHub release artifacts.
- **Docs**: `README.md` rewritten for its audience in the "What's New" voice (PO ruling
  2026-09-13) and corrected where the schema cache and custom servers made the old text untrue;
  `AGENTS.md` § "README authoring standard" and `.agent/DECISIONS.md` D020 make that permanent;
  new `docs/DOCUMENTS-ARCHITECTURE.md`.
- **Gates**: `yarn test` (format check + `eslint --max-warnings 0` + unit) — **719 tests, 719
  pass, 0 fail** (584 at 0.7.9). `yarn install --immutable` clean. `yarn npm audit` — **0 CVEs**.
  Adversarial regression pass vs milestone baseline `57a321e` (v0.7.9): 25 commits, no test file
  deleted, boundary files (`scope-lock`, `documents`, `proxy`, `package-prod`) reviewed —
  **0 confirmed regressions**.

### Known gaps

- The Event viewer has **no filters, no search, no export and no log stream**. The subscription
  seam (`EventBus.subscribe`) exists; turning the pane into a log viewer is a deliberate decision
  nobody has made yet.
- The schema cache introduces a **staleness window**: a tool added or changed on the gateway can
  take up to the TTL (5 minutes by default, or whatever expiry the gateway publishes) to appear,
  unless something triggers a reload first.
- **No live OAuth round-trip** was performed for this release; sign-in paths are covered by unit
  tests only (carried forward from 0.7.x — unchanged).
- The `.mcpb` and `.tgz` artifacts are built and verified locally but **distribution channel
  selection is still open** — see `DISTRIBUTION.md`.
- OAuth tokens still live in `~/.fmcode/credentials.json` (`0600`) rather than VS Code
  SecretStorage (MFDV-480, unchanged).

## [2026-09-10T18:36:33Z] Unreleased-for-review: 0.7.9 — identity card trim; documents tools mode switch

- User: Matthew Fisch + Claude Fable 5.1 (VSIX round 7, PO feedback 2026-09-10)
- Version: 0.7.9
- Commit: (this commit)

### What's New

#### The Signed-in user card says less, and what it says is now unambiguous

Identity provider and Token ID are **gone from the card**. They are diagnostics, not identity, and
they crowded out the two facts that are — Data region and Expires. Both are still one hover away on
the name, and both are still full rows in **Settings ▸ Identity**, which is where you would look for
them deliberately.

Two smaller things went with them. The card read **"expires expires in 4 h"**, because the webview
prefixed a second "expires" onto a phrase that already began with one; that prefix is gone. And the
absolute **Expires** stamp — which was always rendered in your own locale and local time zone, never
UTC — now names the zone, so `9/10/2026, 6:35:07 PM EDT` cannot be misread.

#### Documents tools: choose Local-file mode or Network mode, and the choice is real

The three `grc_documents_*` tools are implemented on **both** sides of the proxy: this extension
handles them as path-based file I/O in your workspace, and the cloud gateway publishes URL-based
(presigned-link) versions of the same three names. Until now the local three always won — silently,
in a hard-coded filter — and no setting could reach the gateway's, because both sides answer to the
same three names and one checkbox governed both.

**Settings ▸ Tools** now shows a second table, **Documents**, with a switch above it:

- **Local-file mode** (default, unchanged behaviour) — the extension handles documents on this
  machine: agents read and write files by path in your workspace, and the extension uploads and
  downloads through your signed-in session.
- **Network mode** — the gateway's URL-based tools are exposed instead: agents receive signed upload
  and download links and move the bytes themselves. No workspace file access.

Whichever is selected, its paragraph appears above the table and the three rows are described **as
that mode behaves** — the same tool name means something materially different in each. The switch
drives exposure, not just wording: it persists to `config.json` alongside the tool checkboxes, the
running proxy picks it up through its config watcher, and the reload sends
`notifications/tools/list_changed` — so a connected agent's tool list follows the switch with
nothing to restart. Per-tool checkboxes still apply in both modes.

### Under the hood

- New `src/registry/documents-mode.ts` owns the whole decision — the option copy, the `tools/list`
  merge rule (`mergeToolLists`) and the `tools/call` routing rule (`dispatchesLocally`) — and
  `src/local-mcp/proxy.ts` consumes both, so the advertised list and the routing cannot drift apart.
  It is `vscode`-free, so all of it is unit-tested rather than living in a webview string literal.
- New `documentsMode` key in `config.json` (`"local" | "network"`, defaulting to `"local"`), mirrored
  as the `fortmesa.documentsMode` VS Code setting.
- `formatExactExpiry` now formats with an explicit component list plus `timeZoneName: 'short'`.
- 32 new unit tests (17 `documents-mode`, 14 `vsix-round7-wiring`, 1 zone-stamp case in `expiry-format`);
  the suite goes 552 → 584, all passing.

## [2026-09-09T18:20:04Z] Release: release/fmmcp-local-v0.7.8-20260909-MFDV-246-tasking

- User: Matthew Fisch + Claude Code
- Version: 0.7.8
- Commit: a4db3797568dac72b9e192f0cd2298b2d7e8d436

### What's New

#### Saferoom for VS Code — 0.7.x: one sign-in page, and it starts and ends on FortMesa

**Sign-in is a single page, not a scavenger hunt.** `FortMesa: Sign In` opens one webview with
both methods visible at once — sign in through a forwarded browser callback, or paste the code the
browser shows. The extension pre-selects whichever fits how you are connected and remembers what
worked last time on this machine; the other method is dimmed, never hidden, with a one-click
**Use this instead**. Continuing as a cached identity, switching accounts, and recovering from
signing in as the wrong person are all on that same page. There is no native input box or quick
pick left anywhere on the sign-in path.

**You land on FortMesa before you land on Auth0.** Adding a user used to drop you straight onto a
consent screen with no indication of which account was about to be used — Auth0 only offers that
choice _after_ asking for credentials. Production now opens a FortMesa identity page first, which
names the identity your browser is already signed in as and forwards only when you click:
**Continue as \<name\>**, or **Use a different account**. Saferoom's own **Continue as \<name\>**
button now agrees with it instead of one of the two being a surprise.

**And you land on FortMesa at the end, too.** The "copy a code" method's browser leg used to
dead-end on the browser's own "can't be reached" page with the authorization code sitting in the
address bar for you to fish out. It now lands on a real FortMesa page that shows the code with a
**Copy** button, and the automatic method finishes on a "You're all set" confirmation. Live on
production, Next and Latest; the sandbox has no OAuth sign-in and is unaffected.

**Scopes: pick a mode, and it saves itself.** The accessible-scopes pane opens on a two-option
toggle — **Selected scopes** or **Run unlocked** — with one line saying what each means, and
`Run unlocked` says plainly that it includes scopes added later. Apply and Cancel are gone: every
change saves as you make it. Zero accessible scopes is now a legal state rather than an error, the
pane follows the signed-in identity, settings sections collapse and lead with what you can act on,
and one word means one idea throughout (**Accessible** / **Inaccessible**).

**Everything the page says, it means.** A copy pass renamed the two methods to what they actually
are, deleted a "chosen because" line that was mis-mapped, made the whole card the control rather
than a radio button inside it, and replaced dumped internals (`timed out after 120000ms`) with
descriptions of what went wrong. Paste errors no longer echo the live code into the page.

**The status bar says one thing, not a list (PO, 2026-09-09).** `GRC: <scopes>` used to spell out
every accessible scope, which got unwieldy fast. It now shows exactly one of: `Not signed-in` (no
valid credential for the active environment — wins even with a scope selected), the scope's own
name when exactly one is accessible, `Connected` for `Run unlocked` mode or more than one accessible
scope, or `Connected · no scopes` for the legal zero-accessible-scopes state. The full list still
lives in the tooltip, truncated at 10 names with a `+n more` tail. Reacts live to both config.json
changes and the identity-events bus, so it repaints on sign-in/out immediately, not just on scope
switches.

**A data region you save a token for becomes a region you can actually use.** Pasting an access token for a non-production region — Functional Testing (Next), say — used
to write the credential to disk and change nothing you could see: the Signed-in user view, the
scope selector, the Tools list and the status bar all kept reading Production, which had no
credential, so the panel said _"Access token saved for Functional Testing (Next)"_ one line above
_"Not signed in · Production (NA-US)"_ and _"No credentials available for env 'prod'"_. Two
different files were involved — the token lands in `credentials.json`, while which region is in
effect lives in `config.json` — and nothing joined them. Now: saving a token for a region
**switches to it when the active region holds nothing usable** (no token, or a provably expired
one) and says `Switched to Functional Testing (Next).`; when the active region is genuinely signed
in, **nothing moves** and you get a one-click **Switch to \<region\>** offer instead, because
seeding a test-region token must never silently re-point live tool calls at another tenant. The
**Data region** section now also chips every region it lists — `Signed in`, `Token saved`,
`Session expired`, `Not signed in` — with an `Active` marker, so a saved-but-inactive credential is
visible rather than inferred. Sign-in (OAuth) continues to target the active region.

**The "Create an access token →" link now opens a page that exists.** It pointed at
`https://<host>/accountProfile#createToken`, missing the `/a/` root slug every FortMesa FE deploy
serves the application under — the bare host is the marketing site. It is now
`https://<host>/a/accountProfile#createToken` for the region selected in the Advanced control, and
it is derived from the same builder as the **FortMesa App** launcher and the sign-in start and
completion pages, so the four cannot drift apart again. Audited the rest: those three were already
correct, and the Partner Portal / Knowledge links point at a different host where `/a/` does not
apply.

**Fixed along the way:**

- **Signing in to production no longer hits Auth0's "Oops!, something went wrong".** The authorize
  request took its audience from the API base URL in `credentials.json`; when that was a
  branded/vanity alias of the production API, Auth0 refused the request outright before the login
  page rendered. Audience and `client_id` now both come from the environment registry — one source
  of truth — so all three sign-in intents, the CLI's `login`, the bundled server's auto-login and
  silent refresh are fixed together. Your stored API base is untouched and still decides where
  REST calls go.
- A pasted value must be the full redirect URL or `code#state`; a bare code is refused everywhere,
  because without `state` its authenticity cannot be checked.
- `state` is verified on every path into a session, paste included, and the browser-callback
  listener releases its port immediately on cancel.
- Sign-out no longer asks for confirmation it does not need; backend refusals reach the user with
  a remediation hint rather than a bare code.

#### 0.7.6, in detail

### Sign-in: you land on FortMesa first, and the code page is live

**The "copy a code" sign-in now ends on a FortMesa page.** Method B's browser
leg used to dead-end on the browser's own "can't be reached" error page, with
the authorization code sitting in the address bar for you to fish out. It now
lands on `<app>/a/auth/saferoom/callback`, which shows the code with a
**[Copy]** button. On for **production, Next and Latest**; the sandbox has no
OAuth sign-in and is unaffected.

This was gated on evidence rather than on the page existing: Auth0 rejects any
`redirect_uri` its stored copy of our client document does not list, so each
environment was checked with an anonymous authorize request (**302** to the
login page = accepted) against an unlisted path on the same client (**403
"Callback URL mismatch"**) as the control.

**Production sign-ins now land on a FortMesa page before Auth0.** Adding a
user sent you straight to a consent screen with no indication of which account
was about to be used. Production now opens
`https://fortmesa.com/a/auth/saferoom/start` first: it names the identity your
browser is already signed in as, and forwards to Auth0 only when you click —
**Continue as \<name\>**, or **Use a different account**. Saferoom keeps its own
**Continue as \<name\>** button too; the two now agree instead of one of them
being a surprise.

The extension hands that page the request's **parameters**, never a URL — the
web app holds the Auth0 address itself — so the page cannot be turned into a
redirector by its own query string, and no code or token is ever on it. The
sign-in panel's **"copy the link"** field is unchanged and still gives you the
real Auth0 URL, because that link is for finishing in a different browser
where the FortMesa page would have no session to show. Next and Latest keep
going straight to Auth0 until their web builds ship the page.

### Fixed

- **Sign-in to production no longer lands on Auth0's "Oops!, something went
  wrong" page.** The authorize request asked Auth0 for an audience taken from
  the API base URL stored in `credentials.json`. When that stored value was a
  branded/vanity alias of the production API (`https://api.vciso.app` — the
  same servers as `https://api.fortmesa.com`, but not a registered Auth0
  resource server), Auth0 refused the request outright with HTTP 403
  `access_denied : Service not found: https://api.vciso.app`, before the login
  page rendered. `client_id` was already taken from the environment registry;
  now the audience is too, so both come from the same single source of truth
  (`src/registry/environments.ts`). Vanity/brand domains are a front-end
  concern and never appear in an MCP sign-in. All three sign-in intents —
  "Continue as <name>", "Use a different account" (`prompt=login`), and a
  first sign-in — go through the one code path and are fixed together, as are
  the CLI's `fmmcp-local login`, the bundled server's auto-login, and silent
  token refresh. Your stored API base is left untouched: it still decides
  where REST calls go.

### Accessible scopes: a mode toggle, and it saves itself

The pane now opens with a two-option toggle — **Selected scopes** / **Run
unlocked** — and one line saying what each means. `Run unlocked` is the mode
that means "every scope you have access to, **including ones added later**";
it lost its button earlier in the same round, when `Select all` stood in for
it, and `Select all` is only a snapshot. In `Run unlocked` the table is hidden
rather than greyed out, and the count line reads `All scopes accessible`.
Switching to it **keeps** your named scopes on disk, so switching back is
lossless.

**Apply and Cancel are gone.** Every change — a checkbox, a shift-click range,
Select all, Clear, the mode toggle — saves by itself two seconds after you stop
clicking, with an **Undo** offered the whole time (and for a moment after), the
way Google's undo works. An Apply button at the bottom of a forty-row table is
a button you have to scroll to find.

Two properties are guaranteed by construction rather than by care, and both are
asserted by driving the state machine, not by reading its source:

- **No storms.** Twenty rapid clicks produce **one** write, and there is never
  more than one write in flight. Each write hot-reloads every running proxy, so
  a burst has to cost one of those, not twenty.
- **No lost clicks.** A click made while a save is in flight does not cancel it
  and is not swallowed by it — the save completes, and your newer change is
  written straight after. A failed save keeps your draft and offers **Retry**;
  it never quietly reverts what you did.

While a change is outstanding, the affected rows read `Applying…` and the count
line still reports what is **saved** — the checkbox answers your click
instantly, but nothing claims the agent can act somewhere until it actually
can.

### Zero accessible scopes is now allowed

You can clear every scope. It was blocked before, which was a UI rule and never
a contract rule: an empty accessible set has always meant "the agent may act
nowhere" and has always failed closed, refusing every scope. It saves as
`mode: "multi"` with an empty list — the old code would have written
`mode: "single"` with zero entries, which is malformed and logged a warning on
every startup.

### The scope pane follows the identity

Signing out, signing in, pasting an access token or switching account now
reloads the Accessible scopes pane and the sidebar, and the pane says
`Signed in as <name> — scopes reloaded`. Previously only the Signed-in user
view noticed: everything else went on showing the previous identity's scopes,
and the sidebar went on calling them accessible. The refresh that reaches those
surfaces is triggered by `config.json` changing, and signing in or out writes
`credentials.json` — which is deliberately not watched, since it holds bearer
tokens and a silent token refresh is not an identity change.

### Settings sections collapse, and lead with what you can act on

Every section in the Settings panel is now expandable, in the order **Agents ·
Tools · Data region · Identity · Scope**, with Agents and Tools open. The
previous order led with Scope and Identity, which are mirrored **read-only**
there — their real controls are the sidebar and the Accessible scopes pane.
What you leave open is remembered per machine.

### Column header

The scope table's id column is labelled **Scope ID**. There is no organisation
column: the scopes API returns no organisation name, and a scope's name already
_is_ the organisation's — adding one would mean either an empty column or a
second network call.

### One word for one idea: Accessible / Inaccessible

Saferoom used "locked" in two opposite senses. "Saferoom is locked to these
scopes" made the listed scopes the _reachable_ ones, while a row badge reading
`locked` was read as "shut out". Where the two met, the result was a summary
line that said **"5 of 5 scope(s) locked"** at the exact moment all five were
reachable.

- **The count was never wrong; the word was.** The number counted the scopes
  you had selected — the ones the agent may act in — and labelled them with the
  word for their opposite. No selection logic changed.
- Every user-facing string now says **Accessible** (the agent may act in this
  scope) or **Inaccessible**. The stored configuration is untouched:
  `config.json` still holds `scopeLock: { mode, scopes }`, and your existing
  selection carries over exactly.

### Choosing scopes

- **The multi-select pane is now a table** — one row per scope with a checkbox,
  name, id and state — with a tri-state header checkbox, a `Select all` /
  `Clear` pair, a live `n of N accessible` count, and a filter box once there
  are more than 12 scopes. Shift-click extends a range; Enter applies.
- **Apply and Cancel.** Ticking a box no longer writes your configuration
  instantly. You build a selection, see each pending change marked in the state
  column, then Apply — or Cancel and keep what you had.
- **Clear works.** Emptying the table used to be refused mid-gesture. It is now
  a normal draft state; Apply is simply disabled until at least one scope is
  selected, and says so.
- **The sidebar lists accessible scopes first**, alphabetically, then the
  inaccessible ones. The table stays purely alphabetical, so rows do not jump
  around as you tick them.
- **"Unlock (All Scopes)" has been removed** from the sidebar — `Select all` in
  the table covers it. One difference worth knowing: the old action meant
  "every scope, including any granted to you later", while `Select all` records
  the scopes that exist today. A scope added to your account afterwards will be
  inaccessible until you select it. The old mode still works if you set it by
  hand in `config.json` or via `fmmcp-local switch --unlock`.

### Signing out

- **No more confirmation.** Clicking sign out signs you out.
- **A pasted access token's button now reads "Remove"**, not "Sign out",
  because removing it from this editor does not revoke it — the token stays
  valid everywhere else it is used. Nothing in Saferoom revokes a token.

### Wording

A pass over every notification, tooltip, button and setting description in the
extension: one idea per string, the action or state first, and no explanatory
clauses. The sign-out prose in particular went from three sentences to a
five-word tooltip. Messages the AI agent reads when a scope is refused were
deliberately left long — their detail is what stops an agent retrying a scope
it can never reach.

### Developer Notes

- The extension hands the FortMesa identity page the authorize request's **parameters**, never a
  URL — the web app holds the Auth0 address itself. The page therefore cannot be turned into a
  redirector by its own query string, and no code or token ever appears on it. The sign-in panel's
  "copy the link" field is unchanged and still yields the real Auth0 URL, because that link exists
  for finishing in a _different_ browser, where the FortMesa page would have no session to show.
- Redirect-URI changes were gated on evidence, not on the page existing: Auth0 validates its own
  stored copy of the client document, so each environment was checked with an anonymous authorize
  request (**302** to the login page = accepted) against an unlisted path on the same client
  (**403 "Callback URL mismatch"**) as the control. Next and Latest go straight to Auth0 until
  their web builds ship the page.
- New pure modules carry the logic and every user-visible string:
  `src/registry/sign-in-method.ts` (method selection, loopback detection, intent params),
  `src/registry/sign-in-page-state.ts` (the page's state machine and its copy),
  `src/extension/sign-in-session.ts` (the session API and its event stream),
  `src/extension/sign-in-page.ts` (the webview). `login-command.ts` was rewritten; the old
  `showInputBox` paste prompt and toast-based outcome reporting are gone.
- `credentials.json` gains an optional `fortmesa_last_identity` display cache per environment.
  It is a display cache and **never an authorization input**.
- Test count moved from 164 at cycle start to 388 passing, deterministic over 6 runs;
  `eslint --max-warnings 0` clean, `yarn npm audit` clean, `yarn install --immutable` clean.
  Security delta review: 0 critical/high, 5 medium fixed in cycle.
- Release artifacts must come from `yarn package:ext:prod`. `verify:prod-strip` fails when
  `FORTMESA_PROD_ONLY` is unset, so an unqualified build can no longer self-certify.
- Licensed under Apache-2.0; NOTICE and third-party notices ship in the package.

**Known gaps**

- **Refresh token is stored in plaintext in `credentials.json`** (MFDV-480) — SecretStorage is
  deferred to next sprint.
- **The hosted browser leg needs DevOps in each environment**: edit the prod client-metadata file
  to list the hosted callback **and** click Auth0 "Refresh Client Metadata". Live on production;
  Next and Latest still pending.
- **Theme rendering and webview behaviour cannot be verified on the pod** — there is no extension
  host. That is what PO acceptance of the VSIX covers.
- The gateway exposes no document _transport_ (D016); the 6-hour parent de-child delay and
  long-lived M2M tokens are accepted.

## [2026-09-08T20:19:30Z] Release: feat/saferoom-vsix — 0.7.3: merged from master (FMENG-3085)

- User: Matthew Fisch + Claude Fable 5.1
- Version: 0.7.3
- Jira: MFDV-246 / FMENG-3085
- Commit: (release commit hash)

### Merged from master (FMENG-3085)

**The sign-in page itself is unchanged from 0.7.2** — none of the sign-in card
work from the previous release is touched by this build. This release folds
in unrelated fixes and improvements that landed on `master` while the sign-in
work was in flight:

- **Credentials now refresh themselves while the local proxy is running.**
  Previously the proxy captured your access token once at startup and kept
  using it until restarted. It now resolves credentials fresh on every
  request, so a token that expires mid-session is refreshed automatically
  instead of failing, and a `login` run in another window while the proxy is
  up is picked up without a restart.
  - **Switching regions/environments no longer risks a stale token.** The
    per-request credential lookup now follows the environment you switch to,
    rather than continuing to resolve the one you just left.
- **Document uploads are now compressed on the wire** (gzip, applied when it's
  worth it), which speeds up larger uploads and reduces bandwidth use — no
  action needed on your part.
- **Fixed an upload/timeout issue** and a **JWT-expiry edge case** in the
  document tools that could previously surface as a failed or hung upload.
- **The gateway now also publishes its own copy of the local document tools**
  for clients that reach it directly; the local proxy's tool list takes
  precedence for anyone going through it, so behavior for existing setups is
  unchanged — this is a naming/architecture note, not a functional change for
  proxy users.

## [2026-09-08T20:07:41Z] Release: feat/saferoom-vsix — sign-in page: every action inside its own card

- User: Matthew Fisch + Claude Fable 5.1
- Version: 0.7.2
- Jira: MFDV-246
- Commit: (release commit hash)

### What's New

**The row of four buttons under the sign-in chooser is gone.** It applied to
whichever card happened to be selected, sat below the choice it acted on, and
pushed the whole page down the moment a flow started. Every action now lives
inside the card it belongs to: the **Automatic browser flow** card holds one
button that starts the browser flow, and the **Code-based sign-in** card holds
everything the code path needs. An unselected card is a title and a
requirement, so selecting one can only grow that card — nothing above it moves.

**The code-based card shows the sign-in link, it does not just copy it.** A
one-line read-only field carries the exact address a copy would put on the
clipboard, with a copy icon beside it that flips to a check when it works. If
the copy button doesn't work — and on some hosts it doesn't — the address is
right there to select and copy by hand. The field selects itself when you focus
or click it. Selecting the card prepares the sign-in so the address is real; it
does not open a browser.

**The paste box behaves like a paste box.** Its **Paste code** button appears
only once you've pasted something, and **Enter** submits.

**The waiting screen replaces the chooser instead of sitting on top of it,**
and its only control is a back arrow in the headline that cancels the attempt
and puts you back on the cards with your choice intact. "Open browser again"
and "Cancel" are gone — back, then start again, does both. The paste fallback
is still there, under a divider, with the same read-only link and copy icon.

**A returning user is greeted by name.** When this machine has signed in
before, the landing shows who that was — avatar, name, email and region — above
the cards. The selected card's button reads **Continue as <name>**, and **Use a
different account** beside the identity starts the same method while forcing
the login form rather than silently reusing an existing session.

### Notes for developers

- `SignInSession` loses `reopenBrowser()`: the button it existed for is gone,
  and a verb nothing can reach is worse than no verb.
- `StartSignInOptions` gains `openBrowser` (default `true`). `false` builds the
  authorize URL, emits `waiting` and waits for a paste without launching
  anything — this is what lets the code-based card show a real link.
- The authorize URL now crosses the extension→webview bridge, deliberately, so
  the read-only field can exist. It is an authorization _request_
  (`client_id`, `state`, PKCE **challenge**, redirect URI) and carries no code,
  token or verifier; the wiring test asserts that none of those names appears
  anywhere in the page or the projector.
- `yarn test:unit`: **408** passing (was 388).
- Fixed a pre-existing flake in `oauth-flow.test.mjs`'s _"uses the redirect URI
  the CALLER resolved"_ test (`fetch failed` / `UND_ERR_SOCKET: other side
closed`, ~1 run in 6 under `yarn test:unit`'s CPU load, present since before
  this branch). `fireCallback` now retries that one transient socket error
  instead of failing on it — test-only, no product code touched.

## [2026-09-08T18:09:32Z] Release: feat/saferoom-vsix — sign-in page: one product voice, and the card is the control

- User: Matthew Fisch + Claude Fable 5.1
- Version: 0.7.1
- Jira: MFDV-246
- Commit: (release commit hash)

### What's New

**The sign-in page reads like a product now, not like a design rationale.** The
two methods are named for what they are — **Automatic browser flow** and
**Code-based sign-in** — and each states its single real requirement ("Needs a
local port this editor can listen on" / "You copy a code from the browser").
The page no longer argues for its own default: the "Chosen because …" line is
gone, along with the uppercase "HOW THE SIGN-IN GETS BACK TO THIS EDITOR"
heading above the cards.

**Picking a method works the way picking a method should.** The two cards are a
proper radio group and the _whole card_ is clickable — no more greyed-out card
with a working link inside it. Arrow keys move between them, Space or Enter
confirms, and the selected card is outlined with a check mark. Neither card is
dimmed or disabled, because both are real choices.

**Failures say what happened.** Where the page used to print the internal error
("Sign-in did not finish: timed out after 120000ms waiting for the OAuth
callback."), it now says "The sign-in timed out — nothing came back from your
browser." Every wait, error and confirmation on the page was rewritten in the
same voice, and each terminal state offers exactly one next action.

### Fixed

- **The method reason line was mis-mapped.** It rendered the _pre-selected_
  method's justification on whichever card was selected, so switching to the
  paste method claimed "your browser can hand the sign-in straight back to this
  editor" — the opposite of the truth. Fixed by removing the line entirely; no
  reason code can reach user-facing copy any more, and a test enforces that.
- **The unselected card was `aria-disabled` while being the only working
  control on the page** — it announced itself as inert to assistive technology
  and still responded to clicks.
- **Paste validation errors echoed the pasted text back into the page.** On the
  code-based method that text is the redirect URL, which carries a live
  authorization code. The messages now describe the problem without repeating
  the input.
- **"Access expires unknown"** could render when a token carried no readable
  expiry; the sentence is dropped instead of filled with a placeholder.

### Developer Notes

- `SignInErrorEvent` gains an optional `kind: SignInFailureKind`
  (`timeout | no-api-base | not-configured | provider-refused |
exchange-failed | state-mismatch | bad-paste | unknown`), set at every emit
  site in `sign-in-session.ts` and mapped to copy by `endedCopy()` in
  `sign-in-page-state.ts`. Additive: an event with no `kind` behaves exactly as
  before, and the previous message-sniff survives as the fallback.
- `SignInPageCardView` is now `{ method, title, requirement, selected }`;
  `reasonLine`, `switchLabel`, `blurb` and `SignInPageModel.reason` are gone.
  `SignInPageView` gains `detail` for the muted technical line.
- No transport or security change: a bare code is still refused, `state` is
  still verified on every path, and no token or authorize URL crosses into the
  webview.
- `test/registry/oauth-flow.test.mjs`: eight single-`setImmediate` waits
  replaced with a `settled()` poll. They assumed one tick was enough for a
  socket to bind, which was true only on an idle runner — this packet's added
  tests were enough extra load to make one of them fail about one run in three.
- `yarn test:unit`: **388 pass / 0 fail** (was 378), verified deterministic
  over six consecutive runs.

## [2026-09-07T17:39:43Z] Release: feat/saferoom-vsix — dedicated sign-in page, both methods always visible

- User: Matthew Fisch + Claude Fable 5.1
- Version: 0.7.0
- Jira: MFDV-246
- Commit: (release commit hash)

### What's New

**Sign-in is one page, with both methods visible at once.** `FortMesa: Sign In`
(palette, Identity pane, and the expired-session notice) now opens a single
webview with two always-visible cards: sign in automatically through a
forwarded browser callback, or paste the code the browser shows. The
extension pre-selects whichever method fits how you're connected and
remembers what worked last time on this machine; the other method is dimmed,
never hidden, with a one-click "Use this instead." There is no native input
box or quick pick left anywhere on the sign-in path.

Continuing as a cached identity, switching accounts, and a wrong-account
mismatch (sign in as someone else, keep or switch) are all on the same page.
A pasted code must be the full redirect URL or `code#state` — a bare code
alone is refused, because its authenticity can't be checked without `state`.

Finishing sign-in in the browser now lands on a small FortMesa "You're all
set" confirmation page instead of a bare redirect.

- Reliability and security: `state` is verified on every path into a session,
  including paste; a browser-callback listener releases its port immediately
  on cancel.
- UX: no native VS Code input box or quick pick anywhere on the sign-in path.

### Developer Notes

- `src/registry/sign-in-method.ts` (new, pure): method selection
  (`chooseDefaultMethod`), loopback URI detection, intent params.
- `src/extension/sign-in-session.ts` (new): the session API — `startSignIn`,
  event stream (`waiting`/`success`/`cancelled`/`error`/`wrong-account`),
  `submitPasted`, `cancel`, `reopenBrowser`, `copyLink`. `onEvent` replays the
  current state to a late subscriber.
- `src/registry/sign-in-page-state.ts` (new, pure): the sign-in page's state
  machine and every string the user reads (`projectSignInPage`).
- `src/extension/sign-in-page.ts` (new): the `fortmesa.signIn` webview panel
  and its client script.
- `src/extension/login-command.ts`: rewritten — `fortmesa.login` and
  `fortmesa.openSignIn` only open the page; the old `showInputBox` paste
  prompt and toast-based outcome reporting are gone.
- `src/registry/oauth-flow.ts`: `runLocalLoopbackFlow` takes an options object
  and resolves (rather than throwing) for `cancelled`/`error`; a bare pasted
  code is rejected everywhere, including the CLI's own prompt.
- `src/registry/environments.ts`: `completionUrl(env, outcome)` — the
  `/a/auth/saferoom/complete` 302 target; `EnvironmentEntry.hostedCallback`
  added, unset until DevOps lists the hosted callback route in each
  environment's Auth0 CIMD record.
- `credentials.json` gains an optional `fortmesa_last_identity` display cache
  per environment (never an authorization input).
- `docs/saferoom-client-metadata.json` re-synced to the live prod document
  (two dormant `/oauth/callback` entries added 2026-08-26 upstream) plus the
  proposed `https://fortmesa.com/a/auth/saferoom/callback` entry for the
  hosted fallback page (not yet deployed/refreshed — see
  `docs/saferoom-client-metadata.README.md` and `.agent/DECISIONS.md` D019).

### Known Gaps (developer-facing, tracked)

- The hosted "paste the code" fallback page (`fmweb-fe`
  `/a/auth/saferoom/callback`) ships independently and needs a DevOps Auth0
  "Refresh Client Metadata" per environment before method B's browser leg
  actually lands there instead of a browser error page (SIGNIN-5c, gated).
- SecretStorage for the OAuth token stays deferred (MFDV-480).

## [2026-09-04T21:21:28Z] Release: feat/saferoom-vsix — document tools explain backend refusals

- User: Matthew Fisch + Claude Fable 5.1
- Version: 0.6.1
- Jira: MFDV-246
- Commit: (release commit hash)

### What's New

**When the server refuses a document action, the tool now says why and what to do.**
Uploads, downloads and deletes that hit a backend refusal used to surface the server's raw message with no guidance.
The local tools now recognise the backend's error codes and attach the same plain-language hints the gateway gives, with a floor for anything unrecognised: the code is named and you are told not to assume a retry will work.
Agents and people get an actionable sentence instead of an internal string.

- Reliability and consistency: local and gateway document errors now read the same way.

### Developer Notes

- `src/shared/api-client.ts`: new `ApiError` (status, code, details) parsing the backend problem+json body — previously no code was extracted at all.
- `src/local-mcp/tool-helpers.ts`: `apiErrorCode/apiErrorStatus/apiErrorDetails` + `remediationHint()` ported (not imported) from fmmcp-gw's `taskRemediationHint`; covers agent_excluded, role_required, invalid_transition, interview_not_submitted, invalid_rrule, duplicate_edge, feature_not_released, validation_failed, 404, and the unknown-code floor. Wired into the three catch blocks in `documents.ts`.
- Gateway-relayed tools already carry the gateway's hints and are unchanged. tools/list output byte-identical to 0.6.0.
- Tests 231 → 247 (new `test/local-mcp/documents-error-hints.test.mjs`, 16 cases, RED→GREEN); lint clean. Source: RESULT-local-mcp-language.md.

## [2026-09-04T19:36:01Z] Release: feat/saferoom-vsix — sign-in by default, honest document tools, tenant-isolation fail-closed

- User: Matthew Fisch + Claude Fable 5.1
- Version: 0.6.0
- Jira: MFDV-246
- Commit: (release commit hash)

### What's New

**Signing in is the default, and pasting a token is the advanced path.**
Agents and people were reaching for long-lived pasted tokens because sign-in was buried and token minting looked like the easy road.
Sign-in now leads the Signed-in user view, pasted tokens live behind an inline "Advanced" expansion with a warning and a deep link to the account profile, and the token-minting command is gone.
You get the safer path first and the escape hatch second, with nothing hidden behind a modal.

**Document tools tell the truth.**
Uploading a file with a filename that already exists in the scope adds a version to that document rather than creating a second one; the tool now says so, returns the same id and a version count, and no longer asks for a flag the server never read.
Delete is described as the two-phase operation it is, and the text that pointed at an archive method that does not exist is gone.

**Tenant isolation fails closed.**
A scope lock configured as single-scope with no scope selected used to permit every scope while the sidebar read "none selected"; it now permits none. The active environment no longer syncs between machines through Settings Sync, and a failed configuration reload quarantines instead of silently widening access.

- The sidebar is reorganised: clearer names, resources grouped, fewer dialogues.
- A visible warning whenever the active environment resolves to production.
- An expired stored token now points you at sign-in instead of a command that no longer exists.
- Reliability and security hardening: webview attribute escaping, cryptographically random content-security nonces, OAuth state verified on the paste-code path, HTTPS required for a custom API base.

### Developer Notes

- Branch merged with origin/master (mcp SDK 2.0, unzip → slim, version bump) at cfd8277; two branch files still importing the removed @modelcontextprotocol/sdk were fixed in the merge.
- Tool schema: `replaceFile` removed from `grc_documents_write` properties and required; still sent internally as a constant because fmweb-be declares it required (document.controller.ts:519) and never reads it (document.service.ts:645-652). Upload response: {id, title, fileSize, createdAt, versionCount}; versionCount polled via list for ≤2 s (get never returns fileVersions).
- Packaging: `package:ext` now sets FORTMESA_PROD_ONLY=false explicitly and `verify:prod-strip` fails when the flag is unset — an unqualified build can no longer self-certify. Release artifacts must come from `yarn package:ext:prod`.
- Security delta review (release Phase 0.75): 0 CRITICAL/HIGH. Fixed here: F-1 attribute escaping, F-2 CSPRNG nonces, F-4 OAuth state on paste path, F-5 verify self-certification, F-6 https-only API base. Deferred: F-3 refresh token stored in plaintext credentials.json → MFDV-480. Not reviewed: master's own mcp SDK 2.0 / unzip changes (merge base).
- Tests 164 → 231 passing (node test runner), eslint --max-warnings 0 clean, yarn npm audit clean, yarn install --immutable clean.
- Blank-persona verification: an agent with only the tool descriptions and a token uploaded and downloaded 1 MiB, 30 MiB and PDF files byte-identical through the local MCP; the only failures were onboarding text and the stale packaged descriptions, both fixed here.
- Known gaps: refresh-token-at-rest (MFDV-480); gateway exposes no document tools (D016, transport redesign with DevOps); the 6-hour parent de-child delay and long-lived M2M tokens are accepted.

## [2026-07-09T02:52:32Z] Brand mark as the status-bar glyph + gallery icon; quieter IDE-sync (D018)

- User: Matthew Fisch + Claude Opus 4.8
- Version: 0.4.0 (folded into the same version, not bumped — nothing has
  shipped externally yet. See `.agent/DECISIONS.md` D017/D018.)
- Jira: MFDV-244
- Commit: (this entry lands with the code it describes; that commit's
  `git log -1 --format=%H` is the hash)

### What's New

**The FortMesa mark now shows up as a proper brand icon across the extension.**
The status bar renders the full FortMesa castle — sized to sit like a native
editor icon rather than floating small — and the Extensions gallery shows the
real brand mark instead of a generic placeholder tile.

- Signing in and launching no longer interrupt you with a sync-status dialog;
  IDE configuration sync runs quietly, with the details a click away in the
  FortMesa output channel.
- More reliable IDE configuration sync.

### Developer Notes

- **Status-bar glyph is now a faithful reproduction of the full brand mark**
  (supersedes the simplified ring+bar glyph from D016). `scripts/build-icon-font.py`
  (numpy + fontTools) converts every element of `media/logo.svg` to filled
  contours by true stroke-to-outline expansion — ring → concentric-circle
  annulus; crenellations/base → per-segment quads + miter joins; banner flares
  → two-sided offset ribbons; fill by non-zero winding. Metrics matched to VS
  Code's codicon convention (measured from `codicon.ttf`: UPM→em, `ascent = em`,
  `descent = 0`, baseline-aligned, glyph fills ~94% of the em) so it fills the
  status-bar cell and inherits codicon vertical centering.
- **Glyph codepoint bumped `U+E900` → `U+E901`** (`build-icon-font.py` +
  `package.json` `contributes.icons`) to bust VS Code's per-codepoint glyph
  cache, which otherwise keeps rendering the previously-rasterized glyph after
  the `.woff` changes at the same codepoint. Referenced by icon id
  `fortmesa-logo`; `status-bar.ts` is unaffected.
- **Gallery/marketplace icon** repointed from a generated raster to the
  canonical brand asset `media/logo.png` (1375×1375 RGBA, transparent);
  removed the intermediate `media/icon.png`. A direct SVG→raster wasn't
  possible in-pod (headless Chrome mis-renders `logo.svg`'s SVG-Tiny-1.2
  profile + group transform, and there is no rsvg/inkscape/cairosvg in the
  hermetic image), so the brand PNG is committed directly.
- **IDE-sync UX** (`src/extension/ide-sync-commands.ts`): the on-activation /
  flag-change pass is now silent — the full report always goes to the
  OutputChannel; only genuine errors raise a (concise) notification; the "IDE
  sync complete" toast fires only for a user-initiated Sync Now / toggle
  (new `{ interactive }` option; activation passes it `false`).
- **`claude` projector update path** (`src/registry/projectors/claude.ts`):
  updating an existing-but-differing entry is now remove-then-add. `claude mcp
add-json` refuses to overwrite an existing server ("MCP server … already
  exists in user config"), which had surfaced as a red error line on every
  launch; a fresh entry is still a plain add.
- Gate: full lint 0, `tsc` build 0, 126 unit tests + hot-reload E2E green,
  0 CVEs. `origin/master` (PR #3) was merged into the branch first — a pure
  history join (working tree unchanged) — so the new PR is conflict-free.

## [2026-07-08T20:00:00Z] Identity surfaces show the real signed-in user via GET /api/v2/me (D017)

- User: Matthew Fisch + Claude Opus 4.8
- Version: 0.4.0 (folded into the same version, not bumped — nothing has
  shipped externally yet. See `.agent/DECISIONS.md` D017.)
- Jira: MFDV-244
- Commit: (this entry lands in the same commit as the code it describes;
  `git log -1 --format=%H` on that commit is the hash — it cannot be known
  before the commit exists, so none is fabricated here)

### What's New

**The Identity panel and the Settings webview's Identity mirror now show the
real signed-in user, not just the environment name.** When signed in, both
surfaces call the backend's `GET /api/v2/me` and display the user's **first
name** (first word of their display name), or their **email** if no display
name is set. The hover tooltip shows their **email** — and will show
`<email> / <provider>` once the backend adds an identity provider (see below).

### Developer Notes

- **One shared implementation**: a new `vscode`-free `fetchIdentity(baseUrl,
token)` in `src/registry/credentials.ts` (reached like `mintTokenViaApi` —
  a plain authenticated REST `fetch`, not an MCP tool) returns
  `{ email, displayName, userId, profileImage, identityProvider? } | undefined`.
  It has a short (4s) timeout and returns `undefined` — **never throws** — on
  any failure. The pure display derivation is factored into
  `identityPrimaryLabel` / `identityTooltip` (also `vscode`-free), consumed by
  both `src/extension/tree-view.ts` (`fetchIdentityRow`) and
  `src/extension/saferoom-settings.ts` (`identitySummaryFor`).
- **Graceful degradation is mandatory and preserved**: `/api/v2/me` only
  exists on the sandbox dev backend today (the FMWEB-3068 PR isn't
  merged/deployed to next/latest/prod), so a 404 / connect failure / timeout /
  missing-creds silently falls back to the CURRENT display (env name as the
  label, JWT `sub` in the tooltip). The panel never breaks.
- **Identity provider is future-proofed, not yet delivered**: `/api/v2/me`
  returns `{ email, displayName, userId, profileImage }` with **no** provider
  field, so the tooltip shows just the email today. `fetchIdentity` already
  consumes an `identityProvider`/`provider` field if the response grows one —
  the BE follow-up (derive it from `FmwebUser.username`, e.g.
  `google-oauth2|123` → `google`) is tracked on the `fmweb-be` FMWEB-3068
  branch. No `fmweb-be` change was made here.
- **Multiple-tokens identifier**: the per-token identifier is the JWT `sub`
  claim (the OidcAuth token-record id, decoded by the existing
  `decodeJwtSubject`). It's kept as a hover-only "token id" line, but matching
  it to a token created in the app's add-token UX is not simple (the app would
  have to surface that OidcAuth id), so no matching was built — per the user.
- **Tests**: new `test/registry/identity-display.test.mjs` unit-tests the pure
  derivation (first-name-else-email; email-only vs `<email> / <provider>`
  tooltip) plus `fetchIdentity`'s parsing and graceful degradation against a
  throwaway loopback server (hermetic). Wired into `test:unit` (now 126
  passing).
- **Verified**: `yarn build && yarn lint && yarn test:unit` green at zero
  warnings; `yarn package:ext` succeeds. Live end-to-end against the sandbox BE
  was **not** possible this pass — `http://localhost:3010` was down (pod
  recreated, port-proxies not up), so verification is structural + unit only.

## [2026-07-08T00:00:00Z] Status-bar glyph fix: valid icon id + codepoint off the codicon range (D016)

- User: Matthew Fisch + Claude Opus 4.8
- Version: 0.4.0 (folded into the same version, not bumped — nothing has
  shipped externally yet. See `.agent/DECISIONS.md` D016.)
- Commit: (this entry lands in the same commit as the code it describes;
  `git log -1 --format=%H` on that commit is the hash — it cannot be known
  before the commit exists, so none is fabricated here)

### What's Fixed

**The FortMesa status-bar glyph now renders.** The extension host was
rejecting the whole icon contribution — its id `fortmesa` was a single
segment, but VS Code requires icon ids to be two segments
(`component-iconname`, e.g. `fortmesa-logo`). With the contribution rejected,
the glyph silently never appeared. The id is now `fortmesa-logo`. As
secondary hygiene the glyph codepoint was also moved off VS Code's codicon
range (`0xEA7C` → `0xE900`) so it can't collide with a built-in codicon.

### Developer Notes

- **Root cause (from the extension-host log)**: `'configuration.icons' keys
… must consist of at least two segments in the form component-iconname`.
  The single-segment id `fortmesa` made VS Code reject the entire
  `contributes.icons` entry. Renamed the icon id `fortmesa` → `fortmesa-logo`
  in `package.json`; updated every `$(fortmesa)` → `$(fortmesa-logo)` in
  `src/extension/status-bar.ts` + `docs/VSIX.md` + `docs/CONFIG-REFERENCE.md`.
  (The view-container id and `fortmesa.*` command ids are unrelated, unchanged.)
- **Secondary (committed first, background subagent `91ee932`)**:
  `scripts/build-icon-font.py` `CODEPOINT` `0xEA7C` → `0xE900`, font
  regenerated (`media/fortmesa-icons.woff`); `package.json` `fontCharacter`
  `\\EA7C` → `\\E900`.
- Verified: `package.json` valid JSON with icon id `fortmesa-logo`;
  `fontTools.ttx -t cmap` shows `code="0xe900"`; `yarn build && yarn lint &&
yarn test:unit` green; `yarn package:ext` repackaged. On-screen rendering
  UNVERIFIED here (no GUI), but the id-format reject was a hard logged error
  so this addresses the confirmed cause. If it still doesn't show after
  reinstall, an old `fortmesa.fmmcp-local` extension may be shadowing
  `fortmesa.saferoom` (uninstall it — D015 / `docs/VSIX.md` §2); reliable
  fallback is a built-in codicon like `$(shield)`.

## [2026-07-07T06:30:00Z] Extension identity split: fortmesa.saferoom (D015)

- User: Matthew Fisch + Claude Sonnet 5
- Version: 0.4.0 (folded into the same version, not bumped — nothing has
  shipped externally yet. See `.agent/DECISIONS.md` D015.)
- Commit: (this entry lands in the same commit as the code it describes;
  `git log -1 --format=%H` on that commit is the hash — it cannot be known
  before the commit exists, so none is fabricated here)

### What's New

**The extension now has its own identity: Saferoom**
`package.json`'s `name` changed from `fmmcp-local` to `saferoom`, so the
extension's VS Code identity is now `fortmesa.saferoom` instead of
`fortmesa.fmmcp-local`. `fmmcp-local` remains the name of the repo, the CLI
command, and the local MCP proxy concept as a whole — this is purely about
what the extension calls itself when you're looking at it from inside the
IDE.

> ⚠️ **If you have a previous build of this extension sideloaded**: this is
> NOT a seamless upgrade. VS Code sees `fortmesa.saferoom` as a different
> extension than `fortmesa.fmmcp-local`. Uninstall the old one from the
> Extensions view, then sideload the new `.vsix` fresh. See
> `docs/VSIX.md` §2.

### Developer Notes

- `package.json`: `"name": "fmmcp-local"` → `"name": "saferoom"`. `"bin"`
  converted from the shorthand string form to the explicit object form
  (`{ "fmmcp-local": "dist/local-mcp/cli.js" }`) so the CLI command name
  stays `fmmcp-local` regardless of the package's own name (npm/yarn's
  shorthand `bin` form ties the installed command name to `name` — verified
  via `yarn bin`, which still lists `fmmcp-local`).
- `yarn.lock`/`.pnp.cjs` regenerated via `yarn install` (this repo has no
  `"workspaces"` field — a single package, so nothing else could have
  depended on the old workspace name via `workspace:*`); `yarn install
--immutable` confirms the regenerated lockfile is consistent.
- An exhaustive 4-way parallel discovery pass across the whole repo (code,
  build config, root docs, docs/.agent — 137 occurrences of "fmmcp-local")
  found exactly one other place that needed to change:
  `docs/VSIX.md`'s composed-identity mention in the install instructions.
  Everything else — the CLI's own `--help` banner, every doc/comment
  referring to "the fmmcp-local CLI"/"the fmmcp-local repo", the MCP
  wire-protocol client self-identification string in `proxy.ts` — correctly
  stays `fmmcp-local`.

## [2026-07-07T05:10:00Z] Post-sideload polish: feat/saferoom-vsix (D014 addendum)

- User: Matthew Fisch + Claude Sonnet 5
- Version: 0.4.0 (folded into the same version, not bumped — same rationale
  as the prior revision slice: nothing from 0.4.0 has shipped externally
  yet. See `.agent/DECISIONS.md` D014 addendum.)
- Commit: (this entry lands in the same commit as the code it describes;
  `git log -1 --format=%H` on that commit is the hash — it cannot be known
  before the commit exists, so none is fabricated here)

### What's New

A hands-on trial of the round above turned up a real regression, a real
font bug, and several rough edges — all fixed here.

- **Agents detection is back**: the Settings panel's Agents checkboxes now
  show, again, whether each IDE is actually detected on your machine (or
  whether your host supports live registration, for VS Code) — this had
  been silently dropped when Agents moved into the webview.
- **A cleaner Identity row**: no more redundant "Signed in —" text (the
  green check already says that); hover the row for more detail. Sign-out
  is now a real icon, not a text link.
- **A real Tools table**: tool descriptions no longer sprawl across the
  panel — they're tidy, truncated, and show the full text on hover.
- **Preview an environment before switching**: the Settings panel's
  Environment picker now shows the Gateway and App URLs for whatever you've
  selected, with an explicit Switch button.
- **The .vsix is now branded FortMesa Saferoom**, matching what the
  extension calls itself everywhere else.
- The status-bar icon-font glyph had a real embedding-permission bug, now
  fixed.
- Reliability and performance improvements.

### Developer Notes

- `src/extension/saferoom-settings.ts`: `buildAgentEntries` restores live
  per-target detection (`detect()` for the four file-based projectors,
  `fork-detect.ts`'s `hasLmMcpProvider` for `vscode`); Tools section
  rewritten as an HTML `<table>` with client-side truncation + `title`
  tooltips; Environment section gained a client-cached URL preview + an
  explicit Switch button (`setEnv` now also no-ops server-side when
  unchanged).
- `src/registry/credentials.ts`: `decodeJwtExpiry` refactored to share a new
  `decodeJwtPayload` helper with the new `decodeJwtSubject` (the JWT's `sub`
  claim — confirmed against a real token that no email/name/userId claim
  exists on it).
- `package.json`: `fortmesa.signOut` was missing an `icon` field entirely
  (a pre-existing bug — the inline hover action rendered as text, never an
  icon); given `$(remove)`, symmetric with Identity's `$(add)`.
  `package:ext` now passes `vsce package -o
"FortMesa-Saferoom-$npm_package_version.vsix"`; the extension's actual
  identity (`name: fmmcp-local`) is untouched.
- `scripts/build-icon-font.py` (new — promoted from an untracked scratchpad
  file): regenerates `media/fortmesa-icons.woff` with `OS/2 fsType=0`
  (Installable Embedding) instead of fontTools' default `4` (Preview &
  Print only, a DRM-style restriction meaningless for a font we author and
  ship ourselves).
- "proxy" replaced with "Saferoom"/"local MCP" in the handful of genuinely
  user-visible strings (`switchers.ts` quickpick/confirm text, `README.md`,
  `docs/VSIX.md`) — left as-is in `docs/CONFIG-REFERENCE.md`'s technical
  knob matrix and code comments, where it's the accurate name of
  `src/local-mcp/proxy.ts`.

## [2026-07-07T02:35:00Z] UX Round 2: feat/saferoom-vsix (panel restructure + webview + tool selector)

- User: Matthew Fisch + Claude Sonnet 5
- Version: 0.4.0 (minor bump — new user-facing features: the tool selector,
  the "Saferoom Settings" webview, and the self-contained launch fix)
- Commit: (this entry lands in the same commit as the code it describes;
  `git log -1 --format=%H` on that commit is the hash — it cannot be known
  before the commit exists, so none is fabricated here)

### What's New

**Try it without opening this repo**
Earlier builds needed this exact repo checked out and opened as your VS Code
workspace, or the extension silently pointed at a proxy script that didn't
exist. The `.vsix` now bundles everything it needs and finds it from its own
install location — sideload it into any window and it works.

**A calmer, scope-first sidebar**
The single crowded "Saferoom" panel is now three focused views — Scopes
(click a row to switch), Identity (sign in from one `+` button, sign out
with a hover), and a two-button Saferoom launcher — plus a new "Saferoom
Settings" panel for environment, agent sync, and tool visibility. The status
bar now shows your active scope, not just the environment.

**Choose which tools your agent can see**
A new Tools panel lets you hide individual tools from an agent's tool list
per your own judgment — handy for keeping a focused, uncluttered tool set
during a session.

- **Open App** — jump straight to the FortMesa web app for your active
  environment from the Saferoom panel.
- The activity bar now shows the real FortMesa mark, and the status bar
  carries a matching glyph.
- Reliability and performance improvements.

### Developer Notes

- `src/registry/environments.ts` (new): single hardcoded source of truth for
  all four environments' gateway + app URLs — closes a real two-place drift
  between `config.ts`'s defaults and `package.json`'s setting default
  (neither previously listed `latest` at all).
- `config.ts` gained `disabledTools: string[]` (zod `.default([])` for
  backward-compatible loading of pre-existing config.json files);
  `proxy.ts` enforces it live in both `tools/list` and `CallTool`, using the
  same live-getter hot-reload pattern the scope lock already used.
- `yarn build:cli` (new): esbuild-bundles `src/local-mcp/cli.ts` into a
  dependency-free `dist-ext/cli.cjs`, so the packaged `.vsix` never needs
  Yarn/PnP at runtime. Fixed a real bug surfaced by this bundling:
  `src/shared/version.ts`'s `import.meta.url` usage is emptied by esbuild's
  `--format=cjs` output and crashed the bundle immediately on load; it now
  resolves its path via `__dirname` when bundled, `import.meta.url` when not.
- `src/extension/tree-view.ts` rewritten as three `TreeDataProvider`s
  (Scopes/Identity/Saferoom launcher); new `src/extension/saferoom-launcher.ts`
  and `src/extension/saferoom-settings.ts` (the webview + its `postMessage`
  bridge); `ide-sync-commands.ts` gained an exported `setIdeSyncTarget`
  shared between the surviving command-palette `Toggle IDE Sync…` and the
  webview's Agents checkboxes.
- `media/logo.svg` (ingested from `fortmesa.com/.well-known/logo.svg`) and
  `media/fortmesa-icons.woff` (a single-glyph icon font, authored with
  Python's `fontTools`) replace the placeholder activity-bar icon and back
  the new `contributes.icons.fortmesa` status-bar glyph.
- `yarn test:unit`: 112 passing (up from 105), including two new suites
  (`extension-resolve-server-spec.test.mjs`, `environments.test.mjs`) and
  `disabledTools` coverage folded into `config.test.mjs`/`settings-sync.test.mjs`.
  `scripts/hot-reload-test.mjs` gained a tool-selector leg. Full details:
  `.agent/DECISIONS.md` D014.

## [2026-07-06T21:44:05Z] Revision slice: feat/saferoom-vsix (post-review hardening)

- User: Matthew Fisch + Claude Code
- Version: 0.3.0 (folded into the same version, not bumped to 0.3.1 — nothing
  from the entry below has shipped externally yet; this slice hardens the
  same unreleased prototype build rather than starting a new release. See
  `.agent/planning/REVISION-PLAN.md` R8 and `.agent/DECISIONS.md` D012 for
  the full rationale trail.)
- Commit: (this entry lands in the same commit as the code it describes;
  `git log -1 --format=%H` on that commit is the hash — it cannot be known
  before the commit exists, so none is fabricated here)

### What's New

A follow-up hardening pass on the Saferoom prototype above, triggered by a
post-implementation review (three independent audits + first-hand
verification) that found the core sound but surfaced one functional bug, two
robustness gaps, and one unwired plan commitment — all fixed here, plus test
coverage designed but not yet built, and a docs sweep.

- **Switching environments no longer risks bricking your session**: if a
  reload targets a gateway that's temporarily unreachable, the proxy now
  keeps serving your previous environment instead of being left with no
  working connection at all.
- **Scope switches now correctly re-arm the local document tools too**: after
  switching your locked scope, `grc_documents_read`/`write`/`delete` now
  immediately honor the new scope — previously they kept enforcing the scope
  you started the session with until you restarted your IDE.
- **The Saferoom panel's Sync Now and Toggle IDE Sync are real**: both were
  placeholder stubs before; Sync Now now actually runs the sync engine and
  reports the same result as the CLI's `fmmcp-local sync`, and Toggle IDE
  Sync actually flips a target's opt-out and re-syncs immediately. The
  Agents tree section now shows live per-target state instead of a permanent
  "Loading…".
- **Antigravity's IDE-sync opt-out no longer creates a config file on
  machines that don't have Antigravity installed** — it now skips cleanly,
  matching how Claude Code, Cursor, and Codex already behaved in that
  situation.
- **A mid-call environment switch now fails clearly** instead of surfacing a
  raw transport error — the in-flight call returns an explicit
  "environment switched mid-call — retry" error.
- **CLI safety nets**: an unmistyped subcommand (e.g. `fmmcp-local statuss`)
  now prints usage and exits instead of silently booting a stdio proxy;
  `--help` is now available; `switch` now tells you to confirm the change
  took effect with `fmmcp-local status` rather than implying it's already
  live.

### Developer Notes

- **F1 (reload robustness)**: `src/local-mcp/proxy.ts`'s `reload()` now
  connects the new gateway client and swaps bindings BEFORE closing the old
  one; a failed connect leaves the previous client/lock serving and logs a
  clear stderr line, rather than leaving `gatewayClient` bound to an already-
  closed transport.
- **F2 (serialized reloads)**: `src/local-mcp/cli.ts`'s config-change handler
  is now serialized through a promise-queue + generation counter — a config
  write that lands while a reload is in flight is enqueued rather than
  racing it; a queued reload superseded by a newer write is skipped (and
  logged) instead of both interleaving nondeterministically.
- **F9 (clear mid-call error)**: closed-transport errors hit during the
  CallTool relay path during a reload window now return
  `toolError('environment switched mid-call — retry')` instead of a raw
  transport rejection.
- **F3 (live lock for documents tools)**: `registerDocumentTools` now takes
  `getLock: () => ScopeLock` instead of a captured `ScopeLock` snapshot; the
  CLI supplies a getter that reads the proxy's live lock
  (`connectedProxy.getLock()`), so `reload()`'s lock swap is observed by the
  local documents handlers too. The proxy-level check stays as defense in
  depth; both now read live state.
- **F4 (IDE sync wired into the VSIX)**: `fortmesa.syncNow` and
  `fortmesa.toggleIdeSync` (`src/extension/ide-sync-commands.ts`, new file —
  replaces the deleted `src/extension/commands.ts` placeholder mechanism)
  now call `syncAllTargets`/`saveConfig` for real; the Saferoom tree's Agents
  section reads live per-target `ProjectorResult` state; `ideSync.vscode`
  gates `provideMcpServerDefinitions` (returns `[]` when off, fires
  `fireChanged()` on flip). Per plan amendment A1, sync now runs on
  activation and whenever an `ideSync.*` flag changes — not on every
  env/scope switch, since the projected IDE config files are byte-stable
  across those and need no re-projection.
- **F5 (Antigravity opt-out no longer fabricates config)**: the disabled
  branch in `src/registry/sync.ts`/`projectors/antigravity.ts` now returns
  `skipped` when the target is undetected AND no existing entry exists,
  mirroring claude/cursor/codex; an existing entry is still correctly
  flipped to `disabled: true`.
- **F6 (write-path hardening)**: every atomic writer (`config.ts`,
  `credentials.ts`, `scope-resolve.ts`, all four projectors) now uses a
  unique tmp filename per write instead of a fixed `${path}.tmp`, closing a
  torn-write window between concurrent writers; credential-bearing tmp files
  are now created with mode `0600` from the start (the post-rename chmod
  stays as belt-and-braces).
- **F7 (CLI footguns)**: an unrecognized positional subcommand now prints
  usage to stderr and exits 1 instead of falling through to `runProxy`;
  `--help` is implemented; `switch`'s success text now hedges
  ("saved; running proxies apply it on their next reload — verify with
  `fmmcp-local status`").
- **F8 (missing designed tests, now built)**: `test/registry/config.test.mjs`
  (schema accept/reject, `resolveEffectiveStartup` precedence, default-file
  creation), `test/registry/settings-sync.test.mjs` (`configEquals`/
  `diffSettingsUpdates`/`snapshotFromConfig`/`configFromSnapshot` round-trip
  plus the loop-termination property), `test/registry/scope-resolve.test.mjs`
  (cache-hit no-network-call, cache-miss resolve-and-merge preserving foreign
  envs/keys, chmod 0600), `test/registry/credentials.test.mjs`, and
  `test/registry/extension-ide-sync-changed.test.mjs` are all new and wired
  into `test:unit`; `scripts/hot-reload-test.mjs` gained the designed
  env-switch-to-a-second-gateway leg (a second gateway on :3022, `activeEnv`
  flip, next call served by the new gateway) plus the F1/F2 bad-gateway-
  fallback and rapid-double-write legs and an F3 regression check (a local
  `grc_documents_read` call against the newly-locked scope after a switch).
- **Plan amendments A1–A4 realized in code, not just planned**: A1 (sync
  cadence) and A3 (repo-colocated `.vsix`, documented in `docs/VSIX.md`) are
  now both actual behavior, not just decisions of record; A2 and A4 were
  clarifications of intent/status rather than code changes. See
  `.agent/DECISIONS.md` D012 for the full amendment text.
- **Test count**: `yarn test:unit` now runs 104 `node:test` assertions
  (re-derive with `yarn test:unit` — do not trust this number blindly in
  future entries), up from the 49 written and unwired / 58 wired-and-passing
  figures in the entry below, reflecting the five new suites above.
- **Verification**: `yarn build && yarn lint && yarn test:unit` clean, zero
  warnings; `scripts/hot-reload-test.mjs` green including its three new legs;
  full-chain `scripts/test-runner.mjs --env sandbox` at its known baseline
  (88 PASS / 2 SKIP / 0 FAIL, modulo the documented #73 sandbox flake);
  `yarn package:ext` succeeds.
- **Backlog unchanged by this slice**: Cursor live-registration API wiring
  (T013), Codex CLI syntax verification (T014), the `environments` add/edit
  UX (D-V8 gap, documented in `docs/CONFIG-REFERENCE.md`), and the other
  items in `TODOS.md` untouched by this pass remain exactly as before.

## [2026-07-06T05:08:21Z] Release: feat/saferoom-vsix

- User: Matthew Fisch + Claude Code
- Version: 0.3.0
- Commit: (this entry lands in the same commit as the code it describes;
  `git log -1 --format=%H` on that commit is the hash — it cannot be known
  before the commit exists, so none is fabricated here)

### What's New

**FortMesa Saferoom: a visual home base for your local AI tools**
A new "FortMesa Saferoom" panel in VS Code puts everything the command-line
tool could already do behind a UI: sign in, switch environments, lock your
session to a specific security scope, and keep every connected AI assistant
— Claude Code, VS Code, Cursor, Codex, and Antigravity — pointed at the same
FortMesa server without hand-editing each tool's config file.

- New Saferoom extension: sign in by pasting an API token or minting a fresh
  one, see your token's expiry at a glance, and sign out cleanly
- Switch your active FortMesa environment (sandbox / next / prod) or your
  security scope lock without restarting anything — a running AI session
  picks up the change live, mid-conversation
- Two scope-lock modes: a simple single-scope switch for everyday work, and
  an "expert" multi-scope mode for intentional cross-scope tasks, plus an
  explicit "unlock all scopes" for when you really mean it
- One-click sync keeps the FortMesa MCP server registered consistently
  across Claude Code, VS Code, Cursor, Codex, and Antigravity, with a
  per-tool opt-out if you'd rather manage one of them yourself
- The foundation for signing in with your FortMesa account right in the
  browser (OAuth) is in place; paste-token sign-in is what works end-to-end
  today while that finishes rolling out

### Developer Notes

- **Canonical config registry** (`src/registry/config.ts`): a schema-validated
  `~/.fmcode/config.json` (`activeEnv`, `scopeLock.{mode,scopes}`,
  `environments`, `ideSync.*`, `logLevel`) is now the single source of truth
  for environment/scope/sync state, mirrored 1:1 as `fortmesa.*` VS Code
  settings (D-V8) via a compare-before-write reconciler
  (`src/extension/settings-sync.ts`) that guards against write loops.
  Precedence is unchanged for the existing harness: CLI flags > config.json >
  built-in defaults.
- **In-process hot-reload** (`src/local-mcp/proxy.ts`'s `reload()`, D-V10):
  the proxy watches `config.json` and, on change, tears down and rebuilds the
  gateway `Client`/`StreamableHTTPClientTransport` with a freshly resolved
  bearer and scope lock, then emits `notifications/tools/list_changed` — the
  stdio pipe to the IDE agent never drops mid-switch. Closes the
  "switch-triggered" half of TODOS T003 (see TODOS T006 for what's left).
  New CLI subcommands ride the same registry: `status`, `switch --env|
--scope`, `token set`, `scopes list`, `sync`.
- **IDE projection layer** (`src/registry/projectors/{claude,cursor,codex,
antigravity}.ts` + `sync.ts`): one canonical `fortmesa` MCP server spec
  (`launch-mcp.sh`, no args — env/scope live in `config.json`, so IDE config
  files are written once and stay byte-stable across switches) projected to
  each target. Official CLI preferred (`claude mcp add-json`, `codex mcp
add`) with a surgical file-merge fallback (`~/.claude.json`,
  `~/.cursor/mcp.json`, `~/.codex/config.toml` via `smol-toml`,
  `~/.gemini/config/mcp_config.json`) that touches only the single
  `fortmesa`/`mcp_servers.fortmesa` key and round-trips every other key/table
  by value. Fixture-based merge tests cover Claude/Codex/Cursor/Antigravity,
  wired into `yarn test:unit`; see TODOS T013–T014 for known gaps (Cursor's
  live registration API is detected but not yet wired in; Codex's CLI
  subcommand syntax is unverified against a real installed CLI).
- **Saferoom VSIX scaffold** (`src/extension/*`): esbuild-bundled
  `dist-ext/extension.cjs` (CJS; the `.cjs` extension is load-bearing against
  this package's `"type": "module"` — see `.agent/DECISIONS.md` D011)
  registers the `fortmesa` server live via
  `vscode.lm.registerMcpServerDefinitionProvider` where available
  (`mcp-provider.ts`), degrading cleanly on forks that lack it
  (`fork-detect.ts` — typed ambient-shape capability probing, zero `any`
  casts, per this repo's lint rules); Saferoom TreeView + status bar
  (`tree-view.ts`, `status-bar.ts`); one command per `fortmesa.*` command ID.
- **Auth**: paste-token and mint-token (`auth-commands.ts`) work end-to-end
  against the sandbox gateway today. OAuth 2.0 Authorization Code + PKCE
  (`src/registry/{pkce,oauth-flow}.ts`, `src/extension/login-command.ts`) is
  fully implemented — a local-loopback callback listener (fixed ports
  43117–43119) for local VS Code installs, paste-code fallback for remote
  extension hosts (this pod always takes that branch) — but remains
  scaffolding until the fmweb-be ticket (VSIX-PLAN.md §8) lands and
  `fortmesa-saferoom` is registered as a trusted OAuth client; until then it
  fails with a clear backend error, by design. No live OAuth round-trip and
  no MongoDB write was performed by this work, per its operating
  constraints.
- **Verification**: `yarn build` and `yarn lint` clean, repo-wide, zero
  warnings; `scripts/test-runner.mjs --env sandbox` at its known baseline
  (88 PASS / 2 SKIP / 0 FAIL); `scripts/hot-reload-test.mjs` (new in this
  phase) green — an env/scope switch is observed live via
  `tools/list_changed`, a scope-filtered `grc_scopes list`, AND (added in the
  revision slice below) a live local `grc_documents_read` call against the
  newly-locked scope; 104 `node:test` unit tests across the registry/
  projector/OAuth/settings-sync modules pass, wired into `yarn test:unit`
  (see the revision-slice entry below for the current count and coverage —
  this figure was 49 at the time this entry was first written).
- **Backlog**: post-prototype items from VSIX-PLAN.md §9, plus debts
  surfaced while building this phase, are now tracked in `TODOS.md` (T002,
  T003, T005–T017) — secure keychain storage, OAuth refresh/silent renewal,
  Marketplace-publish readiness, remote browser-callback OAuth, laptop/
  `mcp-next` validation, the Cursor live-registration gap, and test-coverage
  gaps chief among them.

## [2026-07-03T19:00:47Z] Release: feat/MFDV-244-cli-proxy

- User: Matthew Fisch + Claude Code
- Version: 0.2.0
- Commit: 06c926c

### What's New

**Connect your local AI tools to FortMesa**
A command-line bridge lets IDE assistants (Claude Code, Cursor, Windsurf) work
with FortMesa through the MCP gateway using your own API token, and adds
document upload/download that reads and writes real files on your machine.

- New local MCP proxy — point any stdio MCP client at FortMesa
- Document tools that use real local file paths
- Optional scope-lock to pin a session to specific security scopes

### Developer Notes

- **CLI stdio proxy** (`src/local-mcp/proxy.ts`, `cli.ts`): low-level Server
  facing the IDE relays the gateway's JSON Schemas VERBATIM (zero gateway
  schemas held here); Client + StreamableHTTPClientTransport to the gateway
  with the bearer attached. Scope-lock enforcement relocated from the gateway.
- **Local documents tools** migrated from fmmcp-gw (path-based file I/O incl.
  the DOCUMENT-GET-NULL guards); registry-capture pattern emits JSON Schema via
  zod4 `z.toJSONSchema` and re-validates on call (DECISIONS D007).
- **TokenProvider chain** (`auth/token-provider.ts`): `FORTMESA_API_TOKEN` env
  → `~/.fmcode/credentials.json` (D006 path standardization).
- Scaffold mirrors fmmcp-gw (TS6/ES2024 strict, ESLint 9 flat zero-warning,
  Yarn PnP committed offline cache, husky). ~750 lines duplicated from
  fmmcp-gw, recorded (D005); shared-package extraction tracked (TODOS T004).
- **Verification**: full-chain E2E 87/90 (runner↔proxy↔gateway↔API); tool
  surface exactly 16 (13 proxied + 3 local documents); env-token precedence +
  bad-token resilience probe PASS. 3 residual fails = documented sandbox no-S3
  limitation (fixed by running `--env next`).
- **Distribution**: client package, not an environment deploy — see
  `DISTRIBUTION.md`. VSIX (Saferoom) is the next phase (TODOS T001).
