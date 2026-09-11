import * as vscode from 'vscode';
import { openSignInPage } from './sign-in-page.js';
import { signInMethodMemory } from './sign-in-session.js';
import { errorMessage, type Logger } from './logger.js';

/**
 * `fortmesa.login` — **opens the sign-in page and nothing else.**
 *
 * Everything this command used to do itself now lives in
 * `sign-in-page.ts` / `sign-in-page-state.ts`: choosing a method, the
 * Continue-as / Use-a-different-account choice, the paste field, the
 * wrong-account outcome, and the API-base question for an environment
 * Saferoom does not ship.
 *
 * The last three things that were still here are gone for a reason, not for
 * tidiness:
 *   - the **`showInputBox` for an API base**, because the PO's rule is that no
 *     sign-in question is asked outside the page; it is a field on S0 now,
 *     with the same `requireSecureApiBase` refusal of a cleartext base;
 *   - the **toast-driven outcome reporting**, because a toast cannot offer
 *     "Keep <actual>" vs "Switch account", and reducing a wrong-account
 *     outcome to a warning message is how a user ends up acting on the wrong
 *     tenant's data;
 *   - the **interim "your editor cannot receive the sign-in" dead end** that
 *     SIGNIN-1 left behind for the paste method. The page is where a code is
 *     pasted, so the paste method works from here again.
 *
 * `fortmesa.openSignIn` is registered as an alias so the page has a stable
 * name of its own; both commands do exactly the same thing.
 */
export function registerLoginCommand(context: vscode.ExtensionContext, log: Logger): void {
  const memory = signInMethodMemory(context.globalState);
  const open = (): void => {
    void openSignInPage(context, memory, log).catch((error: unknown) => {
      log.error(`fortmesa.login failed to open the sign-in page: ${errorMessage(error)}`);
      void vscode.window.showErrorMessage(`FortMesa: could not open the sign-in page (${errorMessage(error)}).`);
    });
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('fortmesa.login', open),
    vscode.commands.registerCommand('fortmesa.openSignIn', open),
  );
}
