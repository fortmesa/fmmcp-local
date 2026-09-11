/**
 * Single source of truth for the four FortMesa environments Saferoom knows
 * about: each environment's MCP gateway URL and its app (FE) URL
 * (UX-ROUND-2-PLAN.md W2, decisions D-U7/D-U9).
 *
 * Both values are **hardcoded** for this prototype round — no runtime
 * namespace/host detection, no `BrandAsset`-driven per-scope branding (user
 * decision, 2026-07-06: "not worth getting complex with... we don't have
 * brandAsset visibility yet anyway"). `sandbox`'s app URL in particular is a
 * per-developer value (`dev-mfisch` is this pod's k8s namespace, per the
 * `<service>-<namespace>.mesa.red` convention documented in
 * fm-devcontainer's DECISIONS.md) baked in for this prototype, not derived.
 *
 * `latest`'s gateway URL follows the same `mcp-<env>.dev.fort.blue` DNS
 * pattern as `next` — confirmed against fmmcp-gw's
 * `infrastructure/README.md` activation checklist (`mcp-next.dev.fort.blue`
 * and `mcp-latest.dev.fort.blue` are both created by external-dns from the
 * same Ingress annotation group), not guessed.
 *
 * `src/registry/**` stays `vscode`-free (VSIX-PLAN.md §3.1) — this module is
 * imported by both the CLI and the extension.
 */

/**
 * Build-time prod-only switch. Unset (the default) ships all four
 * environments; set, the build ships prod alone.
 *
 * esbuild substitutes this identifier through `--define` in `build:ext` and
 * `build:cli`, so each guarded expression folds to a literal and dead-code
 * elimination drops `DEV_ENVIRONMENTS` from the bundle. The sandbox, next,
 * and latest hostnames are then absent from the shipped file rather than
 * merely unreachable at runtime. `yarn verify:prod-strip` greps the built
 * bundles and fails the build if any of them survive.
 *
 * The `typeof` guard is what keeps the same source valid under plain `tsc`
 * (the `dist/` CLI build), where nothing defines the identifier. `typeof` on
 * an undeclared binding yields "undefined" instead of throwing, so that
 * build takes the non-prod branch.
 *
 * Each guarded expression repeats the full `typeof ... && ...` test rather
 * than reading a shared `const`. esbuild folds a `--define` substitution in
 * place; routing it through an exported binding first would leave the fold
 * dependent on constant propagation, and DCE would no longer be guaranteed.
 */
declare const __FORTMESA_PROD_ONLY__: boolean;

export interface EnvironmentEntry {
  /** The MCP gateway URL for this environment (what the local proxy connects to). */
  readonly gateway: string;
  /** The FortMesa app (FE) URL for this environment (Saferoom's "Open FortMesa" CTA). */
  readonly app: string;
  /**
   * The human-facing name shown everywhere in the UI. The config-key
   * (`sandbox`/`next`/`latest`/`prod`) stays the on-disk identity — it is
   * what `config.json`, `credentials.json` and every projector key off — so
   * this label is presentation only and never round-trips into a file.
   */
  readonly label: string;
  /**
   * `true` for everything that is not the one production data region. The
   * Data region control shows ONLY the non-advanced entries until the user
   * opens the "advanced" affordance (PO, 2026-09-03: "The dropdown ONLY
   * contains that by default").
   */
  readonly advanced: boolean;
  /**
   * The FortMesa API base for this environment. Sign-in needs it to derive
   * the RFC 8707 `resource` indicator (`registry/oauth-provider.ts`), and it
   * seeds `credentials.json`'s `fortmesa_api_base` on first login — without
   * it, a KNOWN environment still prompts the user to type a URL it already
   * knows. Distinct from `gateway`: the gateway is the MCP endpoint, this is
   * the REST API those tools ultimately call.
   */
  readonly api: string;
  /**
   * The CIMD document URL used verbatim as this environment's OAuth
   * `client_id`. Per-environment and NOT interchangeable: Auth0 authorizes a
   * client against specific resource servers, so presenting production's
   * client_id while requesting next's API is rejected outright
   * ("Client ... is not authorized to access resource server ...").
   *
   * ABSENT means the environment has no OAuth/CIMD login at all — sandbox is
   * token-only (paste/mint) and there are no plans to change that. Sign-in
   * must refuse rather than fall back to another environment's identity.
   */
  readonly clientId?: string;
  /**
   * The hosted OAuth callback page for the PASTE method
   * (`https://<app>/a/auth/saferoom/callback`, PLAN §3.2 / §6).
   *
   * SET for prod/next/latest as of 2026-09-09 (SIGNIN-5c): all three CIMD
   * documents now list `https://<app>/a/auth/saferoom/callback`, and Auth0's
   * client records have been refreshed to match — verified by an anonymous
   * `GET /authorize` per environment returning 302 to the login page, with an
   * unlisted sibling path on the same client returning 403 "Callback URL
   * mismatch" as the negative control. Presenting an unlisted redirect_uri is
   * rejected outright by Auth0, so this field must never be set ahead of that
   * verification.
   *
   * ABSENT for sandbox, permanently: it has no `clientId` and no OAuth login.
   */
  readonly hostedCallback?: string;
  /**
   * Whether this environment's FortMesa web app serves the Saferoom
   * **first-land** page `<app>/a/auth/saferoom/start` (RESULT-VSIX-ROUND4 §3
   * option (ii), PO 2026-09-09): a FortMesa-branded page that shows the user
   * which identity they are about to use and forwards to Auth0 only on an
   * explicit click.
   *
   * When true, the browser Saferoom OPENS is the start page carrying the
   * authorize request's parameters; the authorize URL itself is unchanged and
   * is still what the sign-in page's "copy the link" field hands out, so a
   * user who pastes the link into another browser bypasses the start page and
   * reaches Auth0 directly. No CIMD or Auth0 change is involved — the
   * `redirect_uri` is identical either way.
   *
   * This is a per-environment DEPLOY flag, not a capability: it must stay
   * false until that environment's fmweb-fe build actually routes
   * `auth/saferoom/start`, because a missing route lands the user on the app
   * shell with no way forward.
   */
  readonly firstLandPage?: boolean;
}

/**
 * Non-prod environments — kept in their own object, spread into
 * {@link ENVIRONMENTS} below, so this block is trivially identifiable and
 * strippable when a "public vsix" (ships prod-only) is built later. Not
 * built this round; see UX-ROUND-2-PLAN.md's follow-ups.
 */
const DEV_ENVIRONMENTS = {
  sandbox: {
    gateway: 'http://localhost:3020/mcp',
    app: 'https://fmweb-fe-dev-mfisch.mesa.red/',
    label: 'Development Sandbox',
    advanced: true,
    api: 'http://localhost:3010',
    // No clientId: sandbox has no OAuth/CIMD login — token-only, by design.
  },
  next: {
    gateway: 'https://mcp-next.dev.fort.blue/mcp',
    app: 'https://next.fort.blue/',
    label: 'Functional Testing (Next)',
    advanced: true,
    api: 'https://api-next.dev.fort.blue',
    clientId: 'https://mcp-next.dev.fort.blue/oauth/saferoom-client-metadata.json',
    hostedCallback: 'https://next.fort.blue/a/auth/saferoom/callback',
    // firstLandPage: next's fmweb-fe does not route auth/saferoom/start yet.
  },
  latest: {
    gateway: 'https://mcp-latest.dev.fort.blue/mcp',
    app: 'https://latest.fort.blue/',
    label: 'Quality Preview (Latest)',
    advanced: true,
    api: 'https://api-latest.dev.fort.blue',
    clientId: 'https://mcp-latest.dev.fort.blue/oauth/saferoom-client-metadata.json',
    hostedCallback: 'https://latest.fort.blue/a/auth/saferoom/callback',
    // firstLandPage: latest's fmweb-fe does not route auth/saferoom/start yet.
  },
} as const satisfies Record<string, EnvironmentEntry>;

const PROD_ENVIRONMENTS = {
  prod: {
    gateway: 'https://mcp.fortmesa.com/mcp',
    app: 'https://fortmesa.com/',
    label: 'Production (NA-US)',
    advanced: false,
    api: 'https://api.fortmesa.com',
    // Production uses the permanent identity on the website, not a
    // gateway-served one — the gateway's test route is off in prod.
    clientId: 'https://fortmesa.com/oauth/saferoom-client-metadata.json',
    hostedCallback: 'https://fortmesa.com/a/auth/saferoom/callback',
    firstLandPage: true,
  },
} as const satisfies Record<string, EnvironmentEntry>;

/**
 * Every environment this build knows about. Iteration order is **prod
 * first**, then the three advanced ones (sandbox, next, latest) — the order
 * the Data region control renders them in, so production is always the head
 * of the list and the default selection — narrowing to prod alone in a
 * prod-only build.
 */
export const ENVIRONMENTS: Record<string, EnvironmentEntry> =
  typeof __FORTMESA_PROD_ONLY__ === 'boolean' && __FORTMESA_PROD_ONLY__
    ? { ...PROD_ENVIRONMENTS }
    : { ...PROD_ENVIRONMENTS, ...DEV_ENVIRONMENTS };

/**
 * The environment a fresh `config.json` starts on (`config.ts`'s
 * `DEFAULT_CONFIG.activeEnv`), and the default (and only non-advanced)
 * selection in the Data region control: the production NA-US data region
 * (PO, 2026-09-03 — supersedes the earlier per-build sandbox/prod default;
 * see `test/registry/environments.test.mjs`, updated to match). A prod-only
 * build always ships `prod`, so this needs no build-flag branch of its own.
 */
export const DEFAULT_ENV = 'prod';

/**
 * Validate a user-supplied API base URL, returning it unchanged or throwing.
 *
 * F-6 (security delta, 2026-09-04): the advanced controls accepted a free-text
 * API base and persisted it verbatim with no scheme check, and that base is then
 * used to send the bearer token — over cleartext if the user typed `http://`.
 * Loopback is exempted because the sandbox genuinely runs on
 * `http://localhost:3010` and blocking it would break local development for no
 * confidentiality gain (the traffic never leaves the machine).
 */
export function requireSecureApiBase(base: string): string {
  const trimmed = base.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch (error) {
    throw new Error(`"${trimmed}" is not a valid URL — enter a full API base such as https://api.example.com.`, {
      cause: error,
    });
  }
  if (url.protocol === 'https:') return trimmed;
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  if (url.protocol === 'http:' && loopback) return trimmed;
  throw new Error(
    `API base "${trimmed}" must use https: — an http: base sends your access token in cleartext. ` +
      'Only localhost/127.0.0.1 may use http:.',
  );
}

/** True when `env` is the FortMesa production environment. */
export function isProdEnv(env: string): boolean {
  return env === DEFAULT_ENV;
}

/**
 * The startup warning for production, or `undefined` for any other environment.
 *
 * `activeEnv` defaults to prod and STAYS prod (PO 2026-09-03) — so the safety
 * problem the 2026-09-04 blank-persona test hit is not the default, it is the
 * silence around it: nothing in `--help` or on startup said which environment
 * was about to be driven, and an agent reasonably assumed a sandbox. Warning is
 * the whole fix; do not turn this into a default change or a confirmation
 * prompt (a prompt would break the stdio proxy, which has no terminal).
 */
export function prodWarning(env: string): string | undefined {
  if (!isProdEnv(env)) return undefined;
  return (
    `WARNING: environment "${DEFAULT_ENV}" is FortMesa PRODUCTION — every tool call reads and ` +
    `writes live customer data. This is the default when config.json names no other environment. ` +
    `Pass --env <name> for one run, or run \`fmmcp-local switch --env <name>\` to change it.`
  );
}

/**
 * The API base used when nothing else supplies one: the paste-token prompt's
 * placeholder, and `token-provider.ts`'s last-resort fallback. Kept in sync
 * with {@link DEFAULT_ENV} — both builds always ship `prod`, so this is
 * simply its `api` verbatim rather than a build-flag-conditioned value.
 */
export const DEFAULT_API_BASE: string = PROD_ENVIRONMENTS.prod.api;

/** True when this build was compiled with the prod-only flag set. */
export const PROD_ONLY_BUILD: boolean = typeof __FORTMESA_PROD_ONLY__ === 'boolean' && __FORTMESA_PROD_ONLY__;

/**
 * Whether `name` may be selected as an active environment in this build.
 *
 * A normal build says yes to anything: `config.json` is user-editable and
 * pointing it at a custom gateway is a supported workflow. A prod-only build
 * says yes only to environments it actually ships, so a `config.json` left
 * over from an earlier install cannot put a next or latest entry back in the
 * switcher or accept one through `--env`.
 */
export function isSelectableEnv(name: string): boolean {
  return PROD_ONLY_BUILD ? Object.hasOwn(ENVIRONMENTS, name) : true;
}

/** The display label for an environment key, falling back to the raw key for a user-added custom environment that `ENVIRONMENTS` knows nothing about. */
export function environmentLabel(name: string): string {
  return ENVIRONMENTS[name]?.label ?? name;
}

/**
 * Just the `{ gateway }` shape `config.ts`'s `DEFAULT_CONFIG.environments`
 * (and `package.json`'s `fortmesa.environments` setting default, kept in
 * sync by `test/registry/environments.test.mjs`) need — `app` is
 * Saferoom-UI-only and never lived in `config.json`'s schema.
 */
export function gatewayDefaults(): Record<string, { gateway: string }> {
  return Object.fromEntries(Object.entries(ENVIRONMENTS).map(([name, entry]) => [name, { gateway: entry.gateway }]));
}

/**
 * Deep link to the FortMesa access-token UI for an environment.
 *
 * Token creation is a **modal inside `/accountProfile`**, not a route of its
 * own — but the profile component already acts on a URL fragment
 * (`#updateProfile` jumps it to a step), so `#createToken` is the shape a
 * deep link has to take. ⚠️ fmweb-fe does **not** handle `#createToken`
 * yet (as of 2026-09-03): today this link lands the user on their account
 * profile with the modal closed. That FE follow-up is tracked in this
 * repo's report/TODOs; the link is written in its final shape deliberately
 * so nothing here changes when the FE catches up.
 *
 * Unknown (user-added) environment names fall back to the production app,
 * which is the only URL we can honestly claim exists.
 *
 * ⚠️ Built off {@link appLaunchUrl}, NOT off `app` directly. `/accountProfile`
 * is a route of the fmweb-fe application, and every environment serves that
 * application under the `/a/` channel — the bare host is the marketing site
 * (PO, 2026-09-09: "All environments require /a/ as the root slug for FE
 * deploy (though /b/ works for EA)"). This function shipped without the slug
 * through 0.7.7, so `https://next.fort.blue/accountProfile#createToken` landed
 * users nowhere. Deriving it here rather than repeating the literal is what
 * keeps it from drifting away from the other three FE deep links again.
 */
export function accessTokenUrl(env: string): string {
  return `${appLaunchUrl(env)}accountProfile#createToken`;
}

/**
 * The URL Saferoom's "FortMesa App" launcher opens for an environment.
 *
 * The FortMesa app lives under the `/a/` path of its host, not at the bare
 * root (PO, 2026-09-05: "resources --> open FortMesa should go to fortmesa
 * app at fortmesa.com/a/"). `app` in {@link ENVIRONMENTS} stays the HOST
 * base — it is what the Settings panel's Data region preview shows and what
 * {@link accessTokenUrl} builds `/accountProfile` off — so the `/a/` suffix
 * is derived here rather than baked into every entry. That is what makes
 * sandbox/next/latest resolve to their OWN app host plus `/a/` instead of
 * inheriting production's.
 *
 * Unknown (user-added) environment names fall back to the production app,
 * matching {@link accessTokenUrl}.
 */
export function appLaunchUrl(env: string): string {
  const app = ENVIRONMENTS[env]?.app ?? ENVIRONMENTS[DEFAULT_ENV]?.app ?? 'https://fortmesa.com/';
  return `${app.replace(/\/+$/, '')}/a/`;
}

/** The three outcomes the "You're all set" page renders. */
export type SignInCompletionOutcome = 'ok' | 'cancelled' | 'error';

/**
 * Where the browser is sent once a Saferoom sign-in has finished — the
 * fmweb-fe "You're all set" route (PLAN §3.2, SIGNIN-3):
 * `<app>/a/auth/saferoom/complete?outcome=<ok|cancelled|error>&env=<env>`.
 *
 * This is a **302 target, not an OAuth `redirect_uri`**: the extension's own
 * loopback listener redirects here after the token exchange, so Auth0 never
 * sees this URL and no CIMD change is involved. It carries the outcome and the
 * environment and NOTHING else — no code, no token, no identity — because it
 * lands in the user's browser history and in any referrer the app then sends.
 *
 * Built off {@link appLaunchUrl} so it inherits the `/a/` GA channel (the app
 * root is the marketing site) and the same production fallback for an unknown,
 * user-added environment name. The `env` parameter keeps the RAW name the user
 * is signing in to even when the host fell back, so the page can say something
 * honest.
 */
export function completionUrl(env: string, outcome: SignInCompletionOutcome): string {
  const url = new URL(`${appLaunchUrl(env)}auth/saferoom/complete`);
  url.search = new URLSearchParams({ outcome, env }).toString();
  return url.toString();
}

/** One selectable environment in the Signed-in user view's advanced token control. */
export interface EnvironmentChoice {
  readonly name: string;
  readonly label: string;
  readonly active: boolean;
}

/**
 * Order the configured environment names for a picker: the active one
 * first (it is the default), the rest alphabetical. This is the environment
 * choice that used to live in `pasteToken`'s command-palette quickpick —
 * it survives inline because seeding credentials for a **non-active**
 * environment is otherwise unreachable.
 */
export function environmentChoices(names: readonly string[], activeEnv: string): EnvironmentChoice[] {
  return [...names]
    .sort((a, b) => {
      if (a === activeEnv) return -1;
      if (b === activeEnv) return 1;
      return a.localeCompare(b);
    })
    .map((name) => ({ name, label: environmentLabel(name), active: name === activeEnv }));
}
