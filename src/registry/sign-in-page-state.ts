import { formatExactExpiry, identityPrimaryLabel, type Identity } from './credentials.js';
import { environmentLabel, requireSecureApiBase } from './environments.js';
import { PASTE_NEEDS_BOTH_PARTS, parsePastedCode } from './oauth-flow.js';
import type { SignInIntent, SignInMethod, SignInMethodReason } from './sign-in-method.js';

/**
 * The sign-in page's STATE MACHINE — every state of PLAN-vsix-signin.md §3.1
 * (S0 landing, S1 waiting, S3 signed in, S4 wrong account, S5 cancelled/error)
 * and every transition between them, as a pure reducer.
 *
 * It lives in `src/registry/**` and is therefore `vscode`-free (VSIX-PLAN.md
 * §3.1): `extension/sign-in-page.ts` owns the panel, the HTML and the session,
 * and does nothing but feed actions in and act on the effects that come out.
 * That split is what makes the PO's hard constraints testable — "both methods
 * are always visible", "the paste field is live during a browser flow", "a
 * bare code is refused" are assertions about {@link projectSignInPage}'s
 * output, not about a webview nobody can run in CI.
 *
 * Two design points worth stating because they are easy to get wrong:
 *
 * 1. **Paste shape is validated HERE, before the session ever sees it.**
 *    `sign-in-session.ts` treats a paste failure as terminal (it emits `error`
 *    and the session is finished), which is correct for a STATE mismatch — a
 *    code from another attempt can never be made good, so the only honest
 *    answer is "start again". It is wrong for a malformed paste, where the
 *    user simply has more to copy. So the reducer runs the very same
 *    {@link parsePastedCode} first: an unparseable paste becomes inline
 *    validation with the session untouched, and only a well-formed paste is
 *    handed on. No change to the transport was needed for this.
 * 2. **The reducer never holds the authorize URL, a code, or a token.** Those
 *    stay in the session, host-side. The page's "Copy sign-in link" and
 *    "Open it again" are EFFECTS the host performs; nothing secret is ever
 *    posted into the webview.
 */

/** The five page states of PLAN §3.1. `ended` covers S5 (cancelled and error alike — they differ only in copy). */
export type SignInPageStage = 'landing' | 'waiting' | 'signed-in' | 'wrong-account' | 'ended';

export interface SignInPageIdentity {
  readonly email: string;
  readonly displayName: string;
}

/**
 * The session events the reducer understands. Structurally the terminal +
 * waiting events of `extension/sign-in-session.ts`, redeclared here so this
 * module keeps no import path into the extension layer (which imports
 * `vscode`). The extension's `SignInEvent` is assignable to this by shape;
 * `sign-in-page.ts` asserts that at compile time.
 */
/**
 * Why a sign-in failed, as a CODE the page turns into copy.
 *
 * Optional on the event: the transport sets it at every emit site, but an
 * event without one still behaves exactly as it did before (the page falls
 * back to the message sniff for a state mismatch, and to the generic sentence
 * otherwise). That is what keeps this an additive change to a contract two
 * other callers already depend on.
 *
 * It exists because the alternative — showing `errorMessage(error)` — put
 * "timed out after 120000ms waiting for the OAuth callback." in front of the
 * user on the single most likely failure path there is.
 */
export type SignInFailureKind =
  | 'timeout'
  | 'no-api-base'
  | 'not-configured'
  | 'provider-refused'
  | 'exchange-failed'
  | 'state-mismatch'
  | 'bad-paste'
  | 'unknown';

export type SignInPageSessionEvent =
  | {
      readonly type: 'waiting';
      /**
       * The `/authorize` URL this session will use. It carries `client_id`,
       * `state`, the PKCE **challenge** and the redirect URI — and never a
       * code, a token or a verifier. The page shows it in a READ-ONLY field so
       * the user can see exactly what a copy would put on the clipboard and can
       * copy it by hand when the copy button does not work (PO, round 3).
       */
      readonly authorizeUrl: string;
      readonly expiresAt: number;
      readonly method: SignInMethod;
      readonly hostedPageLive: boolean;
    }
  | { readonly type: 'success'; readonly identity: Identity | undefined; readonly expiry: Date | undefined }
  | { readonly type: 'cancelled' }
  | { readonly type: 'error'; readonly message: string; readonly kind?: SignInFailureKind }
  | {
      readonly type: 'wrong-account';
      readonly intended: string;
      readonly actual: string;
      readonly identity: Identity;
      readonly expiry: Date | undefined;
    };

export type SignInPageAction =
  /** The user picked the other method card — by clicking it, or with the arrow keys. */
  | { readonly type: 'select-method'; readonly method: SignInMethod }
  /** The API-base field for an environment Saferoom does not ship (replaces the old input box). */
  | { readonly type: 'set-api-base'; readonly value: string }
  /** A primary button on S0: Continue as / Use a different account / Sign in. */
  | { readonly type: 'start'; readonly intent: SignInIntent }
  | { readonly type: 'submit-paste'; readonly text: string }
  /** The back arrow in the waiting headline: cancel this attempt and return to the landing with the selection kept. */
  | { readonly type: 'back' }
  | { readonly type: 'copy-link' }
  /** S5's [Try again] and S4's [Switch account]: back to S0, optionally with a new intent already chosen. */
  | { readonly type: 'restart'; readonly intent?: SignInIntent }
  /** S4's [Keep <actual>] — the grant is already written; adopt the account we actually got. */
  | { readonly type: 'keep-account' }
  /** S3's [Done]. */
  | { readonly type: 'done' }
  | { readonly type: 'session'; readonly event: SignInPageSessionEvent };

export type SignInPageEffect =
  | {
      readonly kind: 'start-sign-in';
      readonly intent: SignInIntent;
      readonly method: SignInMethod;
      readonly apiBase: string | undefined;
      /**
       * False PREPARES a session without sending anyone anywhere: the
       * code-based card needs a real authorize URL to display the moment it is
       * selected, but selecting a card is not a request to open a browser.
       */
      readonly openBrowser: boolean;
    }
  | { readonly kind: 'submit-paste'; readonly text: string }
  /**
   * Walk away from the session without letting its events touch the page —
   * the user restarted or swapped method, and the page has already moved on.
   * Distinct from `cancel` on purpose: cancelling emits `cancelled`, which
   * would otherwise overwrite the fresh landing state with S5.
   */
  | { readonly kind: 'abandon-session' }
  | { readonly kind: 'copy-link' }
  /** Forget the running session without cancelling anything (it is already terminal). */
  | { readonly kind: 'release-session' }
  | { readonly kind: 'close-panel' };

/** Everything the page knows. Constructed by {@link initialSignInPageModel} from the transport's `SignInLanding`. */
export interface SignInPageModel {
  readonly stage: SignInPageStage;
  readonly env: string;
  /** False for a token-only region (sandbox): the page shows the notice instead of the sign-in controls. */
  readonly oauthAvailable: boolean;
  /** True when this environment has no built-in and no stored API base — the page asks for one. */
  readonly needsApiBase: boolean;
  readonly apiBase: string | undefined;
  readonly apiBaseError: string | undefined;
  readonly cachedIdentity: SignInPageIdentity | undefined;
  readonly method: SignInMethod;
  readonly hostedPageLive: boolean;
  readonly intent: SignInIntent;
  readonly expiresAt: number | undefined;
  /** The `/authorize` URL of the running or prepared session — never a code or a token. Shown read-only; see the `waiting` event. */
  readonly authorizeUrl: string | undefined;
  /** A session exists (running browser flow, or a prepared code-based one). Gates paste submission and copying. */
  readonly sessionActive: boolean;
  /** A well-formed paste is being exchanged; the submit control says so rather than looking inert. */
  readonly pasteSubmitting: boolean;
  readonly pasteError: string | undefined;
  /** True when the paste error is unrecoverable on this session (a state mismatch): the page offers [Try again], not another paste. */
  readonly pasteErrorFatal: boolean;
  readonly signedInAs: SignInPageIdentity | undefined;
  readonly expiryLabel: string | undefined;
  readonly wrongAccount: { readonly intended: string; readonly actual: string } | undefined;
  readonly endedKind: 'cancelled' | 'error' | undefined;
  readonly endedMessage: string | undefined;
  /** Why the sign-in failed, as a code. Drives the copy; the raw message is only ever a muted detail line. */
  readonly endedFailure: SignInFailureKind | undefined;
}

/** What {@link resolveSignInLanding} produces, minus the parts the page does not use. Kept structural so the extension layer needs no adapter. */
export interface SignInPageLanding {
  /**
   * `reason` is the transport's pre-selection CODE. It is deliberately NOT
   * copied into {@link SignInPageModel}: the page shows no justification for
   * the pre-selection, so nothing may render it. It survives only as a
   * diagnostic in the host's log line.
   */
  readonly choice: { readonly method: SignInMethod; readonly reason: SignInMethodReason };
  readonly cachedIdentity: SignInPageIdentity | undefined;
  readonly hostedPageLive: boolean;
  readonly oauthAvailable: boolean;
  readonly apiBase: string | undefined;
}

export function initialSignInPageModel(env: string, landing: SignInPageLanding): SignInPageModel {
  return {
    stage: 'landing',
    env,
    oauthAvailable: landing.oauthAvailable,
    needsApiBase: landing.apiBase === undefined,
    apiBase: landing.apiBase,
    apiBaseError: undefined,
    cachedIdentity: landing.cachedIdentity,
    method: landing.choice.method,
    hostedPageLive: landing.hostedPageLive,
    intent:
      landing.cachedIdentity !== undefined
        ? { mode: 'continue', email: landing.cachedIdentity.email }
        : { mode: 'fresh' },
    expiresAt: undefined,
    authorizeUrl: undefined,
    sessionActive: false,
    pasteSubmitting: false,
    pasteError: undefined,
    pasteErrorFatal: false,
    signedInAs: undefined,
    expiryLabel: undefined,
    wrongAccount: undefined,
    endedKind: undefined,
    endedMessage: undefined,
    endedFailure: undefined,
  };
}

export interface SignInPageResult {
  readonly model: SignInPageModel;
  readonly effects: readonly SignInPageEffect[];
}

/** A state mismatch is the one paste failure that cannot be retried on this session, so it gets its own short copy and [Try again]. */
const STATE_MISMATCH_COPY = 'That code is from a different sign-in. Start again.';

/** `assertPastedState` throws with this transport-level sentence; the page shows {@link STATE_MISMATCH_COPY} instead. */
function isStateMismatchMessage(message: string): boolean {
  return message.includes('different "state"');
}

function landingAgain(model: SignInPageModel, intent: SignInIntent): SignInPageModel {
  return {
    ...model,
    stage: 'landing',
    intent,
    expiresAt: undefined,
    authorizeUrl: undefined,
    sessionActive: false,
    pasteSubmitting: false,
    pasteError: undefined,
    pasteErrorFatal: false,
    wrongAccount: undefined,
    endedKind: undefined,
    endedMessage: undefined,
    endedFailure: undefined,
  };
}

/**
 * The API base a start would use, or the error to show instead.
 *
 * Extracted because there are now TWO ways into a session: pressing the
 * browser card's button, and merely selecting the code-based card (which
 * prepares a session so its authorize URL is real). Both must apply the same
 * F-6 cleartext refusal, and neither may reach the transport without a base.
 */
function apiBaseForStart(model: SignInPageModel): {
  readonly apiBase: string | undefined;
  readonly error: string | undefined;
} {
  if (!model.needsApiBase) return { apiBase: model.apiBase, error: undefined };
  if (model.apiBase === undefined) return { apiBase: undefined, error: 'Enter an API base URL to sign in.' };
  try {
    // F-6: a user-typed base is what the bearer is sent to — refuse cleartext here, on the page, exactly as the old input box did.
    return { apiBase: requireSecureApiBase(model.apiBase), error: undefined };
  } catch (error) {
    return { apiBase: undefined, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Selecting the code-based card PREPARES a session — silently, with no browser
 * opened — so the read-only link field can show the exact URL a copy would
 * put on the clipboard. If the environment has no usable API base yet there is
 * nothing to prepare and nothing to complain about: the user has not asked to
 * sign in, they have picked a card. The API-base field is already on screen.
 */
function prepared(model: SignInPageModel, intent: SignInIntent): SignInPageResult {
  const { apiBase } = apiBaseForStart(model);
  const base: SignInPageModel = { ...landingAgain(model, intent), method: 'paste' };
  if (!model.oauthAvailable || apiBase === undefined) return { model: base, effects: abandonIfLive(model) };
  return {
    model: { ...base, sessionActive: true, apiBase },
    effects: [...abandonIfLive(model), { kind: 'start-sign-in', intent, method: 'paste', apiBase, openBrowser: false }],
  };
}

/** Walk away from whatever session is live without letting its events repaint the page we have already moved on from. */
function abandonIfLive(model: SignInPageModel): readonly SignInPageEffect[] {
  return model.sessionActive ? [{ kind: 'abandon-session' }] : [];
}

export function reduceSignInPage(model: SignInPageModel, action: SignInPageAction): SignInPageResult {
  switch (action.type) {
    case 'select-method': {
      // Selectable in EVERY state that shows the cards. Swapping abandons any
      // session in flight, because the method decides the `redirect_uri` and
      // that is fixed the moment `/authorize` is built.
      if (action.method === model.method && model.stage === 'landing') return { model, effects: [] };
      if (action.method === 'paste') return prepared(model, model.intent);
      return {
        model: { ...landingAgain(model, model.intent), method: 'browser' },
        effects: abandonIfLive(model),
      };
    }

    case 'set-api-base': {
      const value = action.value.trim();
      const next: SignInPageModel = {
        ...model,
        apiBase: value === '' ? undefined : value,
        apiBaseError: undefined,
      };
      // A code-based card already on screen must re-prepare against the new
      // base, or its link field would keep showing a URL nobody will use.
      return model.method === 'paste' && model.stage === 'landing'
        ? prepared(next, next.intent)
        : { model: next, effects: [] };
    }

    case 'start': {
      if (!model.oauthAvailable) return { model, effects: [] };
      // On the code-based card there is nothing to open: "start" re-prepares
      // the session with the new intent so the link field carries, say,
      // `prompt=login` for "Use a different account".
      if (model.method === 'paste') {
        const { error } = apiBaseForStart(model);
        if (error !== undefined) return { model: { ...model, apiBaseError: error }, effects: [] };
        return prepared(model, action.intent);
      }
      const { apiBase, error } = apiBaseForStart(model);
      if (error !== undefined || apiBase === undefined) {
        return { model: { ...model, apiBaseError: error ?? 'Enter an API base URL to sign in.' }, effects: [] };
      }
      return {
        model: {
          ...model,
          stage: 'waiting',
          intent: action.intent,
          apiBase,
          apiBaseError: undefined,
          authorizeUrl: undefined,
          sessionActive: true,
          pasteSubmitting: false,
          pasteError: undefined,
          pasteErrorFatal: false,
          expiresAt: undefined,
        },
        effects: [
          ...abandonIfLive(model),
          { kind: 'start-sign-in', intent: action.intent, method: 'browser', apiBase, openBrowser: true },
        ],
      };
    }

    case 'submit-paste': {
      // Live wherever a session exists: underneath a running browser flow (the
      // PLAN §3.1 rescue) and on the code-based card, which is where the paste
      // is the whole point.
      if (!model.sessionActive) return { model, effects: [] };
      try {
        parsePastedCode(action.text);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          model: { ...model, pasteError: message, pasteErrorFatal: false, pasteSubmitting: false },
          effects: [],
        };
      }
      return {
        model: { ...model, pasteError: undefined, pasteErrorFatal: false, pasteSubmitting: true },
        effects: [{ kind: 'submit-paste', text: action.text }],
      };
    }

    case 'back':
      // The back arrow replaced the Cancel button AND the "choose another way"
      // CTA: one control that ends the attempt and puts the cards back, with
      // the previous selection kept.
      if (model.stage !== 'waiting') return { model, effects: [] };
      return { model: landingAgain(model, model.intent), effects: abandonIfLive(model) };

    case 'copy-link':
      // Host-side clipboard: a webview's own `navigator.clipboard` is not
      // reliable, and the read-only field is the manual fallback either way.
      if (!model.sessionActive || model.authorizeUrl === undefined) return { model, effects: [] };
      return { model, effects: [{ kind: 'copy-link' }] };

    case 'restart': {
      const intent = action.intent ?? model.intent;
      return {
        model: landingAgain(model, intent),
        effects: [model.sessionActive ? { kind: 'abandon-session' } : { kind: 'release-session' }],
      };
    }

    case 'keep-account': {
      if (model.stage !== 'wrong-account' || model.signedInAs === undefined) return { model, effects: [] };
      return {
        model: { ...model, stage: 'signed-in', wrongAccount: undefined, cachedIdentity: model.signedInAs },
        effects: [],
      };
    }

    case 'done':
      return { model, effects: [{ kind: 'close-panel' }] };

    case 'session':
      return reduceSessionEvent(model, action.event);
  }
}

function reduceSessionEvent(model: SignInPageModel, event: SignInPageSessionEvent): SignInPageResult {
  switch (event.type) {
    case 'waiting':
      // `onEvent` REPLAYS `waiting` to a late subscriber, so this can arrive
      // for a session the page has already left behind (a restart, a method
      // swap). Only the session the page still owns may move the UI.
      if (!model.sessionActive) return { model, effects: [] };
      return {
        model: {
          ...model,
          expiresAt: event.expiresAt,
          authorizeUrl: event.authorizeUrl,
          method: event.method,
          hostedPageLive: event.hostedPageLive,
        },
        effects: [],
      };

    case 'success': {
      const identity =
        event.identity !== undefined
          ? { email: event.identity.email, displayName: identityPrimaryLabel(event.identity) }
          : undefined;
      return {
        model: {
          ...model,
          stage: 'signed-in',
          signedInAs: identity,
          cachedIdentity: identity ?? model.cachedIdentity,
          expiryLabel: formatExactExpiry(event.expiry),
          authorizeUrl: undefined,
          sessionActive: false,
          pasteSubmitting: false,
          pasteError: undefined,
          pasteErrorFatal: false,
        },
        effects: [{ kind: 'release-session' }],
      };
    }

    case 'wrong-account':
      return {
        model: {
          ...model,
          stage: 'wrong-account',
          signedInAs: { email: event.identity.email, displayName: identityPrimaryLabel(event.identity) },
          expiryLabel: formatExactExpiry(event.expiry),
          wrongAccount: { intended: event.intended, actual: event.actual },
          authorizeUrl: undefined,
          sessionActive: false,
          pasteSubmitting: false,
          pasteError: undefined,
          pasteErrorFatal: false,
        },
        effects: [{ kind: 'release-session' }],
      };

    case 'cancelled':
      return {
        model: {
          ...model,
          stage: 'ended',
          endedKind: 'cancelled',
          endedMessage: 'Sign-in cancelled.',
          endedFailure: undefined,
          expiresAt: undefined,
          authorizeUrl: undefined,
          sessionActive: false,
          pasteSubmitting: false,
        },
        effects: [{ kind: 'release-session' }],
      };

    case 'error': {
      // A malformed paste never reaches the session (the reducer catches it),
      // so an `error` on a paste is the STATE mismatch: it ends the session,
      // and the page says so in place, next to the box, with [Try again].
      //
      // The KIND is authoritative when the transport supplies one; the message
      // sniff is kept as the fallback so an event without a kind behaves
      // exactly as it did before this change.
      if (event.kind === 'state-mismatch' || (event.kind === undefined && isStateMismatchMessage(event.message))) {
        return {
          model: {
            ...model,
            pasteError: STATE_MISMATCH_COPY,
            pasteErrorFatal: true,
            pasteSubmitting: false,
            expiresAt: undefined,
            authorizeUrl: undefined,
            sessionActive: false,
          },
          effects: [{ kind: 'release-session' }],
        };
      }
      return {
        model: {
          ...model,
          stage: 'ended',
          endedKind: 'error',
          endedMessage: event.message,
          endedFailure: event.kind ?? 'unknown',
          expiresAt: undefined,
          authorizeUrl: undefined,
          sessionActive: false,
          pasteSubmitting: false,
        },
        effects: [{ kind: 'release-session' }],
      };
    }
  }
}

// ── The view the webview renders ───────────────────────────────────────────
//
// Every string the user reads is produced HERE, host-side, and posted as data.
// The webview's script escapes and places it but never composes copy, which is
// what keeps the PO's wording constraints under test instead of under review.
//
// ROUND 3 LAYOUT (PO, 2026-09-08). The page used to end in a row of four
// buttons — Sign in · Open browser again · Copy link · Cancel — that applied
// to whichever card happened to be selected, sat below the chooser, and pushed
// the whole page down when a flow started. The PO's verdict: *"totally
// confusing … 4!? CTAs"*. So:
//
//   * Every action now lives INSIDE the card it belongs to. The browser card
//     owns one button; the code-based card owns the link field, the copy
//     button and the paste box. The unselected card is a title and a
//     requirement, nothing more — so selecting a card can only grow that card,
//     never the page above it.
//   * The waiting state REPLACES the chooser instead of appearing above it,
//     and its only chrome is a back arrow in the headline.
//   * `Open browser again` is gone: back, then start again, does the same
//     thing with one fewer control on screen. `Cancel` is gone: it is the back
//     arrow. `Copy link` is gone as a button and is now an icon beside the URL
//     it copies.

/** A button the webview renders; `id` is what it posts back. */
export interface SignInPageButton {
  readonly id: SignInPageButtonId;
  readonly label: string;
  readonly primary: boolean;
}

export type SignInPageButtonId =
  | 'continue'
  | 'switch'
  | 'fresh'
  | 'open-token-settings'
  | 'complete-paste'
  | 'copy-link'
  | 'done'
  | 'keep'
  | 'try-again'
  | 'use-different';

/**
 * The identity the machine already knows, rendered ABOVE the cards.
 *
 * PO: *"a 'this is the current user, continue with this user or switch'
 * landing page before the consent screen"*. `Continue as <name>` is the
 * selected card's own action; the switch lives here, next to the face it
 * switches away from, and starts the SAME selected method with `prompt=login`
 * so Auth0 shows the login form instead of silently reusing the SSO session.
 */
export interface SignInPageIdentityView {
  /** One or two letters for the avatar. Derived from the display name, falling back to the email. */
  readonly initials: string;
  readonly displayName: string;
  readonly email: string;
  readonly regionLabel: string;
  readonly switchLabel: string;
}

/**
 * The read-only authorize URL and its copy button.
 *
 * It exists because a copy button can silently fail (no clipboard permission,
 * a remote host, a headless session) and the user is then stuck with no way to
 * see what they were supposed to have. Showing the value makes the copy button
 * an optimisation rather than a dependency — the PO asked for exactly this:
 * *"the opportunity to copy it manually … rather than rely on a copy button
 * that may not work"*.
 *
 * SAFETY: this URL is a REQUEST for authorization. It carries `client_id`,
 * `state`, the PKCE **challenge** and the redirect URI. It never carries an
 * authorization code, an access token or the PKCE verifier — those exist only
 * after the user has signed in, and none of them is ever posted to the webview.
 */
export interface SignInPageLinkView {
  readonly label: string;
  readonly value: string;
  readonly copyLabel: string;
  readonly copiedLabel: string;
}

/** The paste affordance, wherever it appears: inside the code-based card, and under the divider on the waiting state. */
export interface SignInPagePasteView {
  readonly prompt: string;
  readonly placeholder: string;
  /** Shown only when the box is non-empty (the webview enforces that; this is the label it uses). */
  readonly submitLabel: string;
  readonly submittingLabel: string;
  readonly submitting: boolean;
  readonly error: string | undefined;
  /** A state mismatch cannot be re-pasted: the box is replaced by one [Try again]. */
  readonly errorFatal: boolean;
  readonly retryLabel: string;
}

/**
 * One method card. It is a `role="radio"` in a radiogroup: the WHOLE card is
 * the control, both cards are always legible, and neither is ever disabled.
 *
 * A card carries its OWN action(s), and only while it is selected — that is
 * the whole of round 3. `action` is the browser card's single button;
 * `link`/`paste` are the code-based card's field, copy button and paste box.
 */
export interface SignInPageCardView {
  readonly method: SignInMethod;
  readonly title: string;
  /** The one thing this method needs from the user or the machine. Not a pitch. */
  readonly requirement: string;
  readonly selected: boolean;
  readonly action: SignInPageButton | undefined;
  readonly link: SignInPageLinkView | undefined;
  readonly paste: SignInPagePasteView | undefined;
}

/** The back arrow that replaces both `Cancel` and the chooser on the waiting state. */
export interface SignInPageBackView {
  readonly label: string;
  readonly tooltip: string;
}

export interface SignInPageWaitingView {
  readonly headline: string;
  readonly showSpinner: boolean;
  readonly expiresAt: number | undefined;
  /** The sentence that introduces the fallback below the divider. */
  readonly fallbackLeadIn: string;
  readonly link: SignInPageLinkView | undefined;
  readonly paste: SignInPagePasteView;
}

export interface SignInPageView {
  readonly stage: SignInPageStage;
  readonly title: string;
  readonly regionLabel: string;
  /** Rendered in the headline row, before the title. Present only where going back means something. */
  readonly back: SignInPageBackView | undefined;
  /** Token-only region (sandbox): the notice replaces the sign-in controls entirely. */
  readonly tokenOnlyNotice: string | undefined;
  readonly apiBaseField:
    { readonly label: string; readonly value: string; readonly error: string | undefined } | undefined;
  readonly identity: SignInPageIdentityView | undefined;
  readonly message: string | undefined;
  /**
   * A muted technical line under {@link message}, present ONLY for the two
   * failure kinds that have no better copy. The already-shipped fmweb-fe
   * completion page promises "Go back to your editor — it shows the details",
   * so the editor has to actually have them somewhere.
   */
  readonly detail: string | undefined;
  /** Empty in every state but the landing: the waiting and terminal states REPLACE the chooser (PO round 3). */
  readonly cards: readonly SignInPageCardView[];
  readonly waiting: SignInPageWaitingView | undefined;
  /** Terminal states only. The landing and waiting states carry no button row at all. */
  readonly buttons: readonly SignInPageButton[];
}

const CARD_TITLES: Record<SignInMethod, string> = {
  browser: 'Automatic browser flow',
  paste: 'Code-based sign-in',
};

/**
 * Each method's single real requirement, in a few words (PO: *"requires local
 * port direction vs requires copying code"*). This is the only place on the
 * page where a mechanism is named, and it is named because it is the fact the
 * user needs in order to choose — not to justify anything.
 */
const CARD_REQUIREMENTS: Record<SignInMethod, string> = {
  browser: 'Needs a local port this editor can listen on.',
  paste: 'You copy a code from the browser.',
};

const LINK_LABEL = 'Sign-in link';
const COPY_LABEL = 'Copy link';
const COPIED_LABEL = 'Copied';
const PASTE_PROMPT = 'Paste the code or address from the browser';
const PASTE_PLACEHOLDER = 'https://… or code#state';
const PASTE_SUBMIT = 'Paste code';
const PASTE_SUBMITTING = 'Signing in…';
const RETRY_LABEL = 'Try again';
const WAITING_FALLBACK_LEAD_IN = 'If the browser shows a code or an address instead, paste it here.';

function linkView(model: SignInPageModel): SignInPageLinkView | undefined {
  if (model.authorizeUrl === undefined) return undefined;
  return { label: LINK_LABEL, value: model.authorizeUrl, copyLabel: COPY_LABEL, copiedLabel: COPIED_LABEL };
}

function pasteView(model: SignInPageModel, prompt: string): SignInPagePasteView {
  return {
    prompt,
    placeholder: PASTE_PLACEHOLDER,
    submitLabel: PASTE_SUBMIT,
    submittingLabel: PASTE_SUBMITTING,
    submitting: model.pasteSubmitting,
    error: model.pasteError,
    errorFatal: model.pasteErrorFatal,
    retryLabel: RETRY_LABEL,
  };
}

/** Two letters at most, from the display name if it has words, else from the email's local part. */
function initialsOf(displayName: string, email: string): string {
  const source = displayName.trim() !== '' ? displayName.trim() : (email.split('@')[0] ?? email);
  const words = source.split(/[\s._-]+/).filter((word) => word !== '');
  const letters = words.length >= 2 ? `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}` : (words[0]?.slice(0, 2) ?? '');
  return letters.toUpperCase();
}

/**
 * The account button, which now lives INSIDE the browser card.
 *
 * It stays a plain verb phrase saying what happens NEXT. The old "… and copy
 * the address" / "… and get a code" suffixes are gone with the button they
 * were on: the code-based card's actions are the field and the box that are
 * visibly right there, so no button has to describe them.
 */
function browserActionButton(model: SignInPageModel): SignInPageButton {
  const who = model.cachedIdentity;
  return who !== undefined
    ? { id: 'continue', label: `Continue as ${who.displayName}`, primary: true }
    : { id: 'fresh', label: 'Sign in', primary: true };
}

function cards(model: SignInPageModel): readonly SignInPageCardView[] {
  // ORDER IS FIXED — browser first, paste second — regardless of which is
  // selected. Both are always present (PO: never hide the paste method); the
  // selection is a property of a card, not of the list.
  return (['browser', 'paste'] as const).map((method) => {
    const selected = method === model.method;
    return {
      method,
      title: CARD_TITLES[method],
      requirement: CARD_REQUIREMENTS[method],
      selected,
      action: selected && method === 'browser' ? browserActionButton(model) : undefined,
      link: selected && method === 'paste' ? linkView(model) : undefined,
      paste: selected && method === 'paste' ? pasteView(model, PASTE_PROMPT) : undefined,
    };
  });
}

function identityView(model: SignInPageModel, regionLabel: string): SignInPageIdentityView | undefined {
  const who = model.cachedIdentity;
  if (who === undefined) return undefined;
  return {
    initials: initialsOf(who.displayName, who.email),
    displayName: who.displayName,
    email: who.email,
    regionLabel,
    switchLabel: 'Use a different account',
  };
}

function waitingView(model: SignInPageModel): SignInPageWaitingView {
  return {
    headline: 'Your browser is open. Finish signing in there — this page updates on its own.',
    showSpinner: true,
    expiresAt: model.expiresAt,
    fallbackLeadIn: WAITING_FALLBACK_LEAD_IN,
    link: linkView(model),
    paste: pasteView(model, PASTE_PROMPT),
  };
}

/**
 * The ended state's copy, chosen by failure KIND rather than by pasting the
 * transport's exception text on screen.
 *
 * The kinds a user actually reaches — timeout above all — get a plain sentence
 * and no technical text at all. Only the two kinds with nothing better to say
 * carry the raw message, as a muted detail line, because
 * `saferoom-complete.component.html` tells the user the editor shows details
 * and that promise has to be kept somewhere.
 */
function endedCopy(model: SignInPageModel, regionLabel: string): { message: string; detail: string | undefined } {
  if (model.endedKind === 'cancelled') {
    return { message: model.endedMessage ?? 'Sign-in cancelled.', detail: undefined };
  }
  switch (model.endedFailure) {
    case 'timeout':
      return { message: 'The sign-in timed out — nothing came back from your browser.', detail: undefined };
    case 'no-api-base':
      return {
        message: `Saferoom doesn't know the API address for “${model.env}”. Add one in Settings › Advanced.`,
        detail: undefined,
      };
    case 'not-configured':
      return { message: `Saferoom doesn't have sign-in settings for ${regionLabel} yet.`, detail: undefined };
    case 'state-mismatch':
      return { message: STATE_MISMATCH_COPY, detail: undefined };
    case 'bad-paste':
      return { message: "That code couldn't be read. Copy the whole thing and try again.", detail: undefined };
    case 'provider-refused':
      return { message: 'Your identity provider turned the sign-in down.', detail: model.endedMessage };
    case 'exchange-failed':
    case 'unknown':
    case undefined:
      return { message: "The sign-in didn't finish.", detail: model.endedMessage };
  }
}

/** Project the model into everything the webview draws. Pure; the whole of PLAN §3.1's copy lives in here. */
export function projectSignInPage(model: SignInPageModel): SignInPageView {
  const regionLabel = environmentLabel(model.env);
  const base = {
    stage: model.stage,
    title: 'Sign In to FortMesa Saferoom',
    regionLabel,
    back: undefined,
    tokenOnlyNotice: model.oauthAvailable
      ? undefined
      : `${regionLabel} uses access tokens instead of browser sign-in. Add a token in Settings › Advanced.`,
    apiBaseField: undefined,
    identity: undefined,
    message: undefined,
    detail: undefined,
    cards: [],
    waiting: undefined,
    buttons: [],
  } satisfies SignInPageView;

  switch (model.stage) {
    case 'landing':
      // A token-only region has no method to choose and no account to
      // continue as: the notice and one button are the whole page.
      if (!model.oauthAvailable) {
        return { ...base, buttons: [{ id: 'open-token-settings', label: 'Open Settings', primary: true }] };
      }
      return {
        ...base,
        apiBaseField: model.needsApiBase
          ? { label: `API base URL for “${model.env}”`, value: model.apiBase ?? '', error: model.apiBaseError }
          : undefined,
        identity: identityView(model, regionLabel),
        cards: cards(model),
      };

    case 'waiting':
      return {
        ...base,
        back: { label: 'Back', tooltip: 'Cancel and choose another way' },
        waiting: waitingView(model),
      };

    case 'signed-in': {
      const who = model.signedInAs;
      // `formatExactExpiry` yields the literal 'unknown' when the token has no
      // readable `exp`. Never say "expires unknown" — drop the sentence and
      // fold the region into the first one instead.
      const expiry = model.expiryLabel !== undefined && model.expiryLabel !== 'unknown' ? model.expiryLabel : undefined;
      const lead =
        who !== undefined
          ? `Signed in as ${who.displayName === who.email ? who.email : `${who.displayName} (${who.email})`}`
          : `You're signed in`;
      return {
        ...base,
        message:
          expiry !== undefined
            ? `${lead}. Your access to ${regionLabel} expires ${expiry}.`
            : `${lead} — ${regionLabel}.`,
        buttons: [{ id: 'done', label: 'Done', primary: true }],
      };
    }

    case 'wrong-account': {
      // The one terminal state that is genuinely a FORK rather than a retry:
      // a valid grant exists for an account the user did not ask for, and
      // only they can say which one they meant. Two buttons, no back arrow —
      // there is nothing to go back to that would not throw the grant away.
      const wrong = model.wrongAccount;
      return {
        ...base,
        message:
          wrong !== undefined
            ? `You signed in as ${wrong.actual}, not ${wrong.intended}.`
            : 'You signed in as a different account than the one you chose.',
        buttons: [
          { id: 'keep', label: `Continue as ${wrong?.actual ?? 'this account'}`, primary: true },
          {
            id: 'switch',
            label: wrong !== undefined ? `Sign in as ${wrong.intended}` : 'Sign in as someone else',
            primary: false,
          },
        ],
      };
    }

    case 'ended': {
      // ONE next action. `Try again` already returns to the landing with the
      // selection kept, so a back arrow beside it would be the same control
      // twice, and `Use a different account` is on the landing it returns to.
      const failure = endedCopy(model, regionLabel);
      return {
        ...base,
        message: failure.message,
        detail: failure.detail,
        buttons: [{ id: 'try-again', label: RETRY_LABEL, primary: true }],
      };
    }
  }
}

/** Re-exported so the page and its tests share one definition of the malformed-paste sentence. */
export { PASTE_NEEDS_BOTH_PARTS };
