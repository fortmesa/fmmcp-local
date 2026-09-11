/**
 * The Saferoom **first-land** page: `<app>/a/auth/saferoom/start`.
 *
 * PO, 2026-09-09: "I want to land on a webpage for identity choice before
 * proceeding to consent when adding user". RESULT-VSIX-ROUND4 §3 option (ii)
 * is the shape that was approved: the extension hands the FortMesa web app
 * the OAuth request's PARAMETERS — never a URL — and the web app, which
 * already knows its own Auth0 issuer as a compiled constant, rebuilds the
 * authorize URL and forwards to it on an explicit click.
 *
 * Why parameters and not the URL: a page that redirects to a URL supplied in
 * its own query string is an open redirector, and this one would be a
 * FortMesa-branded one sitting in front of the login page. Passing only the
 * parts, with the destination compiled in on the FE side, removes the class
 * of bug rather than validating our way around it.
 *
 * What this module is NOT allowed to change: the authorize URL itself. The
 * `redirect_uri` is identical with or without the start page, so no CIMD or
 * Auth0 record is involved — and the sign-in page's "copy the link" field
 * keeps handing out the REAL Auth0 authorize URL, because that link exists
 * for the user who has to finish the flow in a different browser, where a
 * FortMesa SPA session (and therefore the start page's whole reason to exist)
 * is not present.
 *
 * `src/registry/**` stays `vscode`-free: this is a pure function over strings.
 */

import { ENVIRONMENTS, DEFAULT_ENV, appLaunchUrl } from './environments.js';

/**
 * The query keys copied from the authorize request onto the start URL, in the
 * order the FE packet's contract lists them (BRIEF-FE-SIGNIN-START).
 *
 * It is an ALLOWLIST, not a blocklist, and that direction is the security
 * property: anything the authorize URL grows later — including anything an
 * attacker could talk us into appending — is dropped here by default rather
 * than forwarded by default.
 *
 * `response_type` and `code_challenge_method` deserve their own note.
 * `code_challenge_method` IS forwarded (the FE contract lists it);
 * `response_type` is NOT, because the FE pins `response_type=code` itself —
 * it is not a parameter of this request so much as a property of the only
 * flow either side implements.
 */
export const FIRST_LAND_PARAMS: readonly string[] = [
  'client_id',
  'redirect_uri',
  'code_challenge',
  'code_challenge_method',
  'state',
  'resource',
  'scope',
  'prompt',
  'login_hint',
];

/**
 * Keys that must be present for the start page to be able to build anything.
 * `scope` and `resource` are omitted deliberately — they are optional in
 * `buildAuthorizeUrl` for the legacy appstore flow — while these four are
 * what every CIMD authorize request this codebase produces always carries.
 */
const REQUIRED_PARAMS: readonly string[] = ['client_id', 'redirect_uri', 'code_challenge', 'state'];

/**
 * Query keys that must NEVER appear on a start URL. None of them can be
 * produced by `buildAuthorizeUrl`, so this is defence in depth against a
 * future caller passing the wrong URL in: the start URL is a plain browser
 * navigation that lands in history and in the referrer the FortMesa app then
 * sends, so a credential on it would be a real leak rather than a tidiness
 * problem.
 */
const FORBIDDEN_PARAMS: readonly string[] = ['code', 'access_token', 'id_token', 'refresh_token', 'token', 'assertion'];

/** Whether `env` should land the user on the FortMesa start page first. */
export function firstLandEnabled(env: string): boolean {
  return ENVIRONMENTS[env]?.firstLandPage === true;
}

/**
 * The URL to open in the browser for `env`'s sign-in, given the authorize URL
 * the extension would otherwise have opened.
 *
 * Returns `undefined` — meaning "open `authorizeUrl` directly, as before" —
 * when the environment has no start page, when `authorizeUrl` is unparseable,
 * when a required parameter is missing, or when it carries anything from
 * {@link FORBIDDEN_PARAMS}. Failing back to the plain authorize URL is the
 * right failure mode: sign-in still works, the user just does not get the
 * identity-choice screen.
 */
export function firstLandUrl(env: string, authorizeUrl: string): string | undefined {
  if (!firstLandEnabled(env)) return undefined;

  let authorize: URL;
  try {
    authorize = new URL(authorizeUrl);
  } catch {
    return undefined;
  }

  for (const key of FORBIDDEN_PARAMS) {
    if (authorize.searchParams.has(key)) return undefined;
  }
  for (const key of REQUIRED_PARAMS) {
    const value = authorize.searchParams.get(key);
    if (value === null || value === '') return undefined;
  }

  // `appLaunchUrl` supplies the `/a/` GA channel and the same
  // production fallback for an unknown environment name that
  // `completionUrl` uses — the app ROOT is the marketing site.
  const url = new URL(`${appLaunchUrl(env)}auth/saferoom/start`);
  const search = new URLSearchParams();
  for (const key of FIRST_LAND_PARAMS) {
    const value = authorize.searchParams.get(key);
    if (value !== null && value !== '') search.set(key, value);
  }
  url.search = search.toString();
  return url.toString();
}

/**
 * The URL the extension actually opens in the browser: the start page when
 * this environment has one and the request is well-formed, the authorize URL
 * otherwise. Callers keep using `authorizeUrl` for everything the USER copies.
 */
export function browserOpenUrl(env: string, authorizeUrl: string): string {
  return firstLandUrl(env, authorizeUrl) ?? authorizeUrl;
}

/** Exported for the docs/tests: the start route, relative to the app's `/a/` channel. */
export const FIRST_LAND_ROUTE = 'auth/saferoom/start';

/** The production start page, used in docs and error copy. */
export const PROD_FIRST_LAND_URL = `${appLaunchUrl(DEFAULT_ENV)}${FIRST_LAND_ROUTE}`;
