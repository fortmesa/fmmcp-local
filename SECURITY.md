# Security Architecture — FortMesa MCP

> Cross-cutting security specification for `fmmcp-local` and `fmmcp-gw`.
> This document addresses the full attack surface of the MCP proxy chain.

## 1. Threat Model

### 1.1 What We're Protecting

FortMesa MCP bridges AI agents to GRC (Governance, Risk, and Compliance) data. A breach can expose:

- **Customer compliance posture** — gap analysis, control implementation status
- **Asset inventories** — devices, software, data assets, third-party vendors
- **Vulnerability data** — known vulnerabilities and remediation status
- **Evidence documents** — uploaded compliance evidence
- **Tenant membership** — who has access to which security scopes

This is **regulatory-grade sensitive data**. The security posture must match.

### 1.2 Threat Actors

| Actor                      | Capability                                    | Goal                                          |
| :------------------------- | :-------------------------------------------- | :-------------------------------------------- |
| **Malicious AI prompt**    | Prompt injection via data the agent processes | Exfiltrate data, execute unauthorized actions |
| **Compromised MCP client** | Modified IDE agent sending crafted JSON-RPC   | Bypass scope isolation, privilege escalation  |
| **Network attacker**       | MITM on the Local→Cloud transport             | Steal JWTs, intercept GRC data                |
| **Careless user**          | Storing tokens in plaintext, sharing configs  | Credential leakage                            |
| **Supply chain**           | Compromised npm dependency                    | RCE on user machine or cloud gateway          |

### 1.3 Attack Surface Map

```
┌─────────────────────────────────────────────────────────────┐
│  User's Machine                                              │
│                                                              │
│  [AI Agent] ──stdio──► [Local MCP Proxy] ──HTTPS──► [Cloud] │
│       ▲                      ▲                               │
│       │                      │                               │
│   1. Prompt              2. Token                            │
│      Injection              Storage                          │
│                              │                               │
│                         3. Transport                         │
│                            Security                          │
└──────────────────────────────┼───────────────────────────────┘
                               │
                    ═══════════╪═══════════
                               │
                    4. Gateway  │  5. API
                       Auth    ▼     Access
                    ┌──────────────────────┐
                    │  Cloud MCP Gateway    │
                    │                      │
                    │  6. Input           │
                    │     Validation      │
                    │                      │
                    │  7. Rate            │
                    │     Limiting        │
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │  Continurisk API      │
                    └──────────────────────┘
```

## 2. Security Controls

### 2.1 Transport Security (Attack Surface 3)

| Control                    | Implementation                                                                                     |
| :------------------------- | :------------------------------------------------------------------------------------------------- |
| **TLS Required**           | All Local→Cloud communication MUST use HTTPS. HTTP plaintext is REJECTED in production.            |
| **TLS Version**            | TLS 1.2 minimum, TLS 1.3 preferred                                                                 |
| **Certificate Validation** | Default Node.js CA bundle. `NODE_TLS_REJECT_UNAUTHORIZED=0` is FORBIDDEN in production.            |
| **Dev Exception**          | `localhost` connections in dev mode MAY use HTTP. Controlled by `fortmesa.gateway.devUrl` config.  |
| **Origin Validation**      | Cloud Gateway validates `Origin` header on all Streamable HTTP connections (MCP spec requirement). |

### 2.2 Credential Storage (AWS Credential Chain Model)

**Principle: Follow the AWS CLI gold standard.** AWS stores credentials in `~/.aws/credentials` (plaintext, `chmod 600`) and it is the industry-accepted pattern. We adopt the same model.

#### Credential Chain (resolved in order)

| Priority | Source                                                | Use Case                         |
| :------- | :---------------------------------------------------- | :------------------------------- |
| 1        | Environment variable: `FORTMESA_API_TOKEN`            | CI/CD, automation, containers    |
| 2        | Shared credentials file: `~/.fmcode/credentials.json` | CLI interactive, multi-tool      |
| 3        | VS Code SecretStorage                                 | VSIX extension path              |
| 4        | SSO/OAuth cached tokens: `~/.fmcode/sso/cache/`       | OAuth consent flow (short-lived) |
| 5        | Interactive prompt                                    | Fallback — first-run or expired  |

#### File Security

| Control                   | Implementation                                                                              |
| :------------------------ | :------------------------------------------------------------------------------------------ |
| **File Permissions**      | `~/.fmcode/credentials.json` created with `0600` (owner read/write only)                    |
| **Permission Check**      | CLI/VSIX warns if credentials file has permissions wider than `0600`                        |
| **Directory Permissions** | `~/.fmcode/` created with `0700`                                                            |
| **Token Lifetime**        | Short-lived JWTs (15-minute expiry recommended). Refresh tokens stored in credentials file. |
| **Token Scope**           | JWTs MUST be scoped to a single `scopeId`. No cross-tenant tokens.                          |
| **Token Rotation**        | On scope switch, old session terminated, new JWT issued for new scope.                      |
| **Memory Handling**       | Tokens cleared from memory on extension deactivation. No token caching in global variables. |
| **Clipboard**             | NEVER copy tokens to clipboard. No "copy token" UI action.                                  |

#### Credentials File Format

```ini
# ~/.fmcode/credentials.json
[default]
api_token = fm_tok_abc123...

[profile:staging]
api_token = fm_tok_def456...
```

### 2.3 Gateway Authentication (Attack Surface 4)

| Control               | Implementation                                                                                 |
| :-------------------- | :--------------------------------------------------------------------------------------------- |
| **JWT Validation**    | Every request validated: signature (JWKS), `exp`, `iss`, `aud`, `scopeId`                      |
| **JWKS Caching**      | Cache JWKS keys with 1-hour TTL. Re-fetch on signature failure (key rotation support).         |
| **Clock Skew**        | Allow 30-second clock skew for `exp`/`nbf` validation                                          |
| **Token Binding**     | JWT `scopeId` claim MUST match the request's operational scope. Cross-scope requests REJECTED. |
| **Session Isolation** | Each MCP session is bound to exactly one JWT/scopeId pair. No session sharing.                 |
| **Replay Prevention** | `jti` (JWT ID) claim tracked. Duplicate JTIs rejected within the token's validity window.      |

### 2.4 Input Validation (Attack Surface 6)

**Principle: ALL input from the AI agent is UNTRUSTED. Treat it like user input from an anonymous internet form.**

| Control                  | Implementation                                                                              |
| :----------------------- | :------------------------------------------------------------------------------------------ |
| **Schema Validation**    | Every tool input validated via Zod schemas BEFORE any API call. No passthrough.             |
| **Type Coercion**        | Disabled. Inputs must match expected types exactly.                                         |
| **String Length**        | Maximum string length enforced per field (e.g., `assetLabel` max 500 chars).                |
| **ID Validation**        | All ObjectID parameters validated as 24-char hex strings.                                   |
| **Injection Prevention** | No string interpolation into queries or commands. All API calls use parameterized requests. |
| **No Code Execution**    | Gateway NEVER executes code, shell commands, or eval() based on tool inputs.                |
| **Error Messages**       | Validation errors return field-level details but NEVER expose internal system state.        |

### 2.5 Prompt Injection Defense (Attack Surface 1)

| Control                          | Implementation                                                                                                                      |
| :------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------- |
| **Tool Description Integrity**   | Tool descriptions are static, compiled into the gateway binary. Cannot be modified at runtime.                                      |
| **No Dynamic Tool Registration** | Tool list is fixed at build time. No mechanism for runtime tool addition (prevents tool poisoning).                                 |
| **Response Sanitization**        | API responses are JSON-serialized. No raw HTML, markdown, or executable content returned to the agent.                              |
| **Scope Boundary**               | Tools can ONLY access data within the authenticated `scopeId`. Even if the agent is tricked, blast radius is limited to one tenant. |
| **Audit Trail**                  | All tool invocations logged with: tool name, scopeId, timestamp, input hash, response status.                                       |

### 2.6 Rate Limiting (Attack Surface 7)

| Control                 | Implementation                                                                                       |
| :---------------------- | :--------------------------------------------------------------------------------------------------- |
| **Per-Tenant**          | Token bucket per `scopeId` — prevents one tenant from affecting others                               |
| **Per-Session**         | Additional session-level rate limit — prevents a compromised session from burning the tenant's quota |
| **Burst Protection**    | Bucket size 100, refill 20/min. Prevents rapid enumeration attacks.                                  |
| **Write Amplification** | Write operations (create, update, delete) have separate, lower rate limits (10/min).                 |
| **429 Response**        | Includes `Retry-After` header. No penalty escalation on first offense.                               |

### 2.7 Authorization & Least Privilege (Attack Surface 5)

| Control                 | Implementation                                                                                               |
| :---------------------- | :----------------------------------------------------------------------------------------------------------- |
| **Scope Isolation**     | Every API call includes `scopeId`. No cross-scope data access possible.                                      |
| **Role Enforcement**    | Gateway checks JWT role claims before executing write operations. Read-only roles cannot invoke write tools. |
| **Tool Filtering**      | Semantic routing filters tool visibility based on user role. Read-only users don't see write tools.          |
| **No Admin Escalation** | No tool provides scope management, user management, or permission changes. These remain UI-only.             |

## 3. Supply Chain Security

| Control                  | Implementation                                                                                               |
| :----------------------- | :----------------------------------------------------------------------------------------------------------- |
| **Dependency Pinning**   | All dependencies pinned to exact versions in `yarn.lock`                                                     |
| **Audit Schedule**       | `yarn npm audit` on every commit (pre-commit hook) and weekly scheduled scan                                 |
| **Minimal Dependencies** | Prototype: 4 direct deps (`@modelcontextprotocol/sdk`, `zod`, `jose`, `vscode`/`express`). Resist dep creep. |
| **Lock File Integrity**  | `yarn.lock` committed and reviewed. Changes to lock file flagged in PR review.                               |
| **No Eval**              | CSP-style prohibition: no `eval()`, `Function()`, `vm.runInContext()` anywhere in codebase                   |

## 4. Logging & Observability

### 4.1 What We Log

| Event           | Logged Fields                                                   | Sensitive? |
| :-------------- | :-------------------------------------------------------------- | :--------- |
| Auth success    | `scopeId`, timestamp, auth method                               | No         |
| Auth failure    | timestamp, failure reason, IP                                   | No         |
| Tool invocation | tool name, `scopeId`, timestamp, input schema keys (NOT values) | No         |
| API error       | tool name, `scopeId`, HTTP status, error code                   | No         |
| Rate limit hit  | `scopeId`, session ID, current rate                             | No         |

### 4.2 What We NEVER Log

- JWT tokens (even partial)
- Request/response bodies containing user data
- Asset names, vulnerability details, document contents
- User email addresses or personal information
- Stack traces in production (only in dev mode)

## 5. VSIX Extension Security

| Control            | Implementation                                                           |
| :----------------- | :----------------------------------------------------------------------- |
| **Activation**     | Extension activates only in trusted workspaces (VS Code Workspace Trust) |
| **Permissions**    | Minimal VS Code API permissions. No file system access beyond config.    |
| **SecretStorage**  | Uses VS Code's encrypted secret storage for all credentials              |
| **No Telemetry**   | Extension does not collect or transmit telemetry data                    |
| **CSP**            | Webview content (if any) uses strict Content Security Policy             |
| **Update Channel** | VSIX distributed via VS Code Marketplace with signed package             |

## 6. OAuth 2.1 Flow Security

| Control                | Implementation                                                                                                                                                                                                                                                         |
| :--------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PKCE Required**      | All OAuth flows use PKCE (Proof Key for Code Exchange). No implicit flow.                                                                                                                                                                                              |
| **State Parameter**    | Random `state` parameter verified on **every** completion path, not just the loopback callback — including the sign-in page's manual paste method (a code pasted without its `state` half is refused before it ever reaches the session; see `docs/VSIX.md` §5, D019). |
| **Redirect URI**       | Pinned to `http://127.0.0.1:{random_port}/callback` (forwarded over `asExternalUri` on remote hosts). No wildcard redirects.                                                                                                                                           |
| **Loopback Only**      | Callback server binds to `127.0.0.1` only. Never `0.0.0.0`.                                                                                                                                                                                                            |
| **Port Randomization** | Callback port randomized per auth flow to prevent port squatting                                                                                                                                                                                                       |
| **Timeout**            | Auth flow times out after 120 seconds. Callback server destroyed on timeout.                                                                                                                                                                                           |

## 7. Development vs Production

| Concern        | Development                    | Production                 |
| :------------- | :----------------------------- | :------------------------- |
| Transport      | HTTP allowed to `localhost`    | HTTPS required             |
| Token storage  | SecretStorage (same as prod)   | SecretStorage              |
| Logging        | Verbose, includes stack traces | Structured JSON, no PII    |
| Rate limiting  | Disabled or lenient            | Enforced                   |
| JWT validation | Validate against dev JWKS      | Validate against prod JWKS |
| CORS           | Permissive for dev tools       | Strict origin whitelist    |
