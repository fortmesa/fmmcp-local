# `saferoom-client-metadata.json` — what this file is

This is the repo's copy of the Auth0 **Client ID Metadata Document (CIMD)**
served at `https://fortmesa.com/oauth/saferoom-client-metadata.json`. Auth0
uses this URL _as the client ID_ for the Saferoom extension and CLI — it reads
the JSON to learn the client's name, logo, and (critically) `redirect_uris`:
the only addresses Auth0 will ever send a signed-in browser back to. Anything
not on that list is refused with "Callback URL mismatch".

## This copy is the intended-prod document, not necessarily the live one

This file tracks what **should** be live in prod. It is kept in sync with the
live document (`curl`'d) plus any redirect URI additions engineering has
proposed but that DevOps/releng have not yet deployed and refreshed. As of
2026-09-07 that means: the live file's four loopback entries plus
`https://fortmesa.com/a/auth/saferoom/callback` (the hosted "paste the code"
fallback page, PLAN-vsix-signin.md §5/§7 Request 1 — **not yet deployed
live**).

## Two steps, not one — editing this file changes nothing by itself

1. **Releng** deploys this content to the S3 object behind
   `https://fortmesa.com/oauth/saferoom-client-metadata.json` and invalidates
   the CloudFront cache (edge caches it 24h: `s-maxage=86400`).
2. **Auth0 admin** must then open Dashboard › Applications › Applications ›
   the client whose Client ID is this URL ("FortMesa Saferoom") ›
   **Refresh Client Metadata** › confirm the preview shows the new redirect
   URI › Save. Auth0 keeps its own cached copy of the document and does not
   re-read it on every request — only on this explicit refresh. Proof: the
   `http://localhost/oauth/callback` / `http://127.0.0.1/oauth/callback`
   entries were added to the live file on 2026-08-26 and were rejected by
   Auth0 for as long as no refresh had happened.

**Status, 2026-09-09: DONE and ACCEPTED.** The live file lists both
`https://fortmesa.com/a/auth/saferoom/callback` and the `/b/` (EA channel)
twin, and Auth0's client record has been refreshed — Verify 1b below returns
**302**, and an unlisted sibling path on the same client returns **403
"Callback URL mismatch"** as the control. The same is true of the two
gateway-served documents (`mcp-next` / `mcp-latest`), whose `/a/` callbacks
also verify 302. The extension turned the hosted paste page on for all three
in `src/registry/environments.ts` (`hostedCallback`) on the same date.
Saferoom itself only ever builds `/a/` URLs; the `/b/` entries are listed so
the EA channel of the web app can serve the same route.

## Verify (no login needed)

```bash
# 1a — confirm the file itself is updated (after releng deploys + invalidates)
curl -sS https://fortmesa.com/oauth/saferoom-client-metadata.json | grep -c 'a/auth/saferoom/callback'   # expect 1

# 1b — confirm Auth0 has actually refreshed its stored record (after Save)
# 302 = accepted, 403 "Callback URL mismatch" = still rejected
curl -sS -o /dev/null -w '%{http_code}\n' 'https://auth.fortmesa.com/authorize?response_type=code&client_id=https%3A%2F%2Ffortmesa.com%2Foauth%2Fsaferoom-client-metadata.json&redirect_uri=https%3A%2F%2Ffortmesa.com%2Fa%2Fauth%2Fsaferoom%2Fcallback&scope=openid&state=verify&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256'
```

See `.agent/DECISIONS.md` D019 and `PLAN-vsix-signin.md` §5/§7 (in the planning
KB) for the full request text and the next/latest equivalents (`fmmcp-gw`
`src/server/http.ts`, code not a file).
