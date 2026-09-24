import { z } from 'zod';
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { readTool, writeTool, type ToolRegistrar } from './registry.js';
import { apiFetch } from '../../shared/api-client.js';
import { buildUploadBody } from '../../shared/compress-upload.js';
import { toolResult, toolError, getErrorMessage, requireParam, remediationHint } from '../../shared/tool-helpers.js';
import type { ToolHandlerResult } from './registry.js';
import type { ScopeLock } from '../../shared/scope-lock.js';

// FORKLIFT-LANDED: relocated from fmmcp-gw src/tools/documents.ts (path-based file I/O
// belongs on the user's machine; the HTTP gateway excludes these tools — gw D016).

/** How often an in-flight upload reports progress, keeping the client's request clock alive. */
const PROGRESS_INTERVAL_MS = 5000;

/** Upper bound on the post-upload version readback. See countVersions(). */
const VERSION_POLL_BUDGET_MS = 2000;
const VERSION_POLL_INTERVAL_MS = 200;

/** upload_status polling budget, matching the gateway's so both behave the same. */

/**
 * Number of stored file versions for a freshly-uploaded document.
 *
 * The upload response's `fileVersions` is normally EMPTY: fmweb-be writes the GridFS
 * version asynchronously and it lands ~100 ms after the POST returns. Reporting that 0
 * made a successful upload indistinguishable from a failed one, so we read it back.
 *
 * The readback targets `GET /api/v2/documents/{id}` (get). This used to poll the LIST,
 * because `documentListV2Mapping` was the only mapper that named `fileVersions` and
 * `documentDetailsV2Mapping` omitted it. That is now inverted: versions are a
 * detail-only read, and the list no longer carries them, so polling the list would
 * always observe 0.
 *
 * Bounded and non-fatal by construction: the upload has already succeeded by the time we
 * are called, so a slow or failing readback returns 0 rather than turning a good upload
 * into an error.
 */
async function countVersions(scopeId: string, documentId: unknown, initial: unknown): Promise<number> {
  if (Array.isArray(initial) && initial.length > 0) {
    return initial.length;
  }
  if (typeof documentId !== 'string' || documentId === '') {
    return 0;
  }
  const deadline = Date.now() + VERSION_POLL_BUDGET_MS;
  do {
    await new Promise((resolve) => setTimeout(resolve, VERSION_POLL_INTERVAL_MS));
    try {
      const doc = (await apiFetch(`/api/v2/documents/${documentId}`, { params: { scopeId } })) as Record<
        string,
        unknown
      > | null;
      const versions = doc?.fileVersions;
      if (Array.isArray(versions) && versions.length > 0) {
        return versions.length;
      }
    } catch {
      // The upload itself succeeded; a failed readback must not fail the tool call.
      return 0;
    }
  } while (Date.now() < deadline);
  return 0;
}

/**
 * Call a gateway tool and return its result verbatim.
 *
 * Supplied by the proxy so these handlers can DELEGATE rather than
 * reimplement. Every method except the two that touch the filesystem is the
 * gateway's to answer: it owns the REST calls, the `docName` rename, the
 * document-type vocabulary and the presigned-URL rewriting. A second copy here
 * is what let the two surfaces drift apart -- the type enum had to be corrected
 * on both sides on 2026-09-11, and `download_url` returned a bucket URL from
 * this side while the gateway returned one on its own host.
 */
export type GatewayRelay = (toolName: string, args: Record<string, unknown>) => Promise<ToolHandlerResult>;

export function registerDocumentTools(server: ToolRegistrar, getLock: () => ScopeLock, relay: GatewayRelay): void {
  // ── Read (Tier 1) ───────────────────────────────────────────
  server.registerTool(
    'grc_documents_read',
    {
      description:
        'Read document operations. Use "list" to enumerate documents in a scope, "get" for metadata ' +
        '(includes preSignedUrl for system-generated docs), "download" to save a document file to disk, ' +
        'or "generate" to create a system report (e.g., SSP, POA&M). ' +
        'Download handles both paths: presigned URL for system-generated docs and GridFS stream for uploaded docs. ' +
        'Generate is async — the tool queues the job and polls until the document reports a downloadable ' +
        'location (preSignedUrl for system reports, gridfsFileName for uploaded files). ' +
        'Use grc_documents_write to upload or update documents. Use grc_documents_delete to permanently remove a document.' +
        '\n\nFILE VERSIONS: uploading the same filename twice adds a version rather than creating a second ' +
        'document. Only "get" returns them, under "fileVersions", newest first; "list" omits them. Pass a ' +
        'version\'s "_id" as versionId to "download" or "download_url" to fetch that specific version. ' +
        '"length" on a version is the size of the file as uploaded, not the stored byte count.' +
        '\n\nPREFER "download", which writes the file to filePath. "download_url" returns a URL instead, ' +
        'and exists so this tool matches the hosted gateway. That URL is served by the FortMesa MCP gateway ' +
        'files proxy (https://mcp.fortmesa.com/files/…), signed for 60 minutes, and GET-able with your normal ' +
        'fetch tool / HTTP client — no S3 access needed.' +
        '\n\nReturns JSON. The API does NOT expose a generation "status" or a "fileSize" on any of these ' +
        'methods — do not branch on either; readiness is indicated by preSignedUrl/gridfsFileName being non-empty. ' +
        'list: [{ "id": "...", "title": "...", "documentType": "...", "documentFormat": "...", "createdAt": "..." }] ' +
        'get: { "id": "...", "title": "...", "documentType": "...", "preSignedUrl": "...", "gridfsFileName": "..." } ' +
        'download: { "success": true, "message": "Downloaded to /path", "bytes": 12345, "source": "gridfs" } ' +
        'generate: { "id": "...", "documentType": "securityPlanDoc", "documentFormat": "pdf", "preSignedUrl": "..." } ' +
        '\n\nCAVEATS — read before relying on this surface. ' +
        '(1) "list" returns system report TEMPLATES as well as real documents; templates are not stored records ' +
        'and therefore have NO "id" — address them by "documentType" when calling generate. A row without an ' +
        '"id" is a template, not a broken document. ' +
        '(2) "list" may return the same uploaded document TWICE with identical ids (the API merges an ' +
        '"uploaded" and a "recently created" bucket without de-duplicating). De-duplicate by id. ' +
        '(3) "controlList" (the controls a document is linked to as evidence) is populated only for documents ' +
        'created in the last 24 hours that have evidence links, and never on system report templates. It is ' +
        'NOT a dependable way to find a document for a given control — expect it to be absent and fall back to ' +
        'matching on title. ' +
        '(4) "createdAt"/"downloadedAt" on system-generated documents are unreliable and may predate the call.',
      ...readTool('Documents'),
      inputSchema: {
        method: z.enum(['list', 'get', 'download', 'download_url', 'generate']).describe('Operation to perform'),
        scopeId: z.string().min(1).describe('Security scope ID'),
        documentId: z.string().min(1).optional().describe('Document ID (required for get, download)'),
        filePath: z
          .string()
          .optional()
          .describe('Local file path to save the downloaded document to (required for download)'),
        versionId: z
          .string()
          .min(1)
          .optional()
          .describe(
            'download and download_url: fetch one specific version instead of the current one. Version ids ' +
              'are the "_id" of an entry in the "fileVersions" array returned by "get"',
          ),
        // For generate:
        documentType: z
          .enum([
            // ── Structured documents (formats: pdf, docx, html) ──
            'assetInventoryDoc',
            'controlImplementationDoc',
            'controlAssessmentDoc',
            'controlPolicyDoc',
            'cyberPosturingSummary',
            'securityCharterDoc',
            'securityPlanDoc',
            'securityGapDoc',
            'attestationDoc',
            'attestationTrustmarkDoc',
            'vulnerabilitySummaryDoc',
            'vulnerabilityFindingsDoc',
            'serviceProviderBillingDoc',
            // ── Data exports (formats: csv, xlsx, tsv, json, ods) ──
            'vulnerabilityCsvReport',
            'customervulnerabilityCsvReport',
            'assetInventoryReport-device',
            'assetInventoryReport-software',
            'assetInventoryReport-data',
            'controlsProfileCsv',
            'controlsCatalogCsv',
            'customerControlsProfileCsv',
            'customerControlsCatalogCsv',
            'serviceProviderBillingCsvDoc',
          ])
          .optional()
          .describe(
            'System document type to generate — required for generate. ' +
              'Two categories: (1) Structured documents (assetInventoryDoc, controlImplementationDoc, securityPlanDoc, etc.) ' +
              'use formats: pdf, docx, html. ' +
              '(2) Data exports (vulnerabilityCsvReport, assetInventoryReport-device, controlsProfileCsv, etc.) ' +
              'use formats: csv, xlsx, tsv, json, ods.',
          ),
        documentFormat: z
          .enum(['pdf', 'docx', 'html', 'csv', 'xlsx', 'tsv', 'json', 'ods'])
          .optional()
          .describe(
            'Output format — required for generate. ' +
              'Structured documents: pdf, docx, html. ' +
              'Data exports: csv, xlsx, tsv, json, ods.',
          ),
      },
    },
    async ({ method, scopeId, documentId, filePath, versionId, documentType, documentFormat }) => {
      try {
        // FORKLIFT-LANDED: scope-lock enforcement now lives here by design.
        getLock().assertAuthorized(scopeId);
        // `download` is the only read this process can answer that the gateway
        // cannot: it writes bytes to a local path. Everything else is relayed.
        if (method !== 'download') {
          return await relay('grc_documents_read', {
            method,
            scopeId,
            ...(documentId !== undefined ? { documentId } : {}),
            ...(versionId !== undefined ? { versionId } : {}),
            ...(documentType !== undefined ? { documentType } : {}),
            ...(documentFormat !== undefined ? { documentFormat } : {}),
          });
        }
        // `method` is narrowed to 'download' by the relay guard above.
        requireParam('documentId', documentId);
        requireParam('filePath', filePath);

        // Try to get doc details — may contain presigned URL for system-generated docs
        let details = (await apiFetch(`/api/v2/documents/${documentId}`, { params: { scopeId } }).catch(
          () => null,
        )) as Record<string, unknown> | null;

        // BE QUIRK (DOCUMENT-GET-NULL): get-by-id can 200 with a null body for valid
        // IDs. Fall back to list + match before declaring the ID invalid.
        if (details === null) {
          const all = (await apiFetch('/api/v2/documents', { params: { scopeId } }).catch(() => [])) as Record<
            string,
            unknown
          >[];
          details = all.find((d) => (d.id ?? d._id) === documentId) ?? null;
        }

        // NOTE: details may still be null here (both lookups missed) — the
        // /download endpoint below is authoritative, so metadata absence alone
        // doesn't prove the doc is gone (fresh uploads can lag the list).
        if (details !== null && typeof details.preSignedUrl === 'string' && details.preSignedUrl !== '') {
          // System-generated doc — fetch from presigned S3 URL
          const s3Response = await fetch(details.preSignedUrl);
          if (!s3Response.ok) {
            throw new Error(`S3 download failed: HTTP ${String(s3Response.status)}`);
          }
          const buffer = Buffer.from(await s3Response.arrayBuffer());
          await writeFile(filePath, buffer);
          return toolResult({
            success: true,
            message: `Downloaded to ${filePath}`,
            bytes: buffer.length,
            source: 'presigned_url',
          });
        }

        // User-uploaded doc (or system doc without presigned URL) — stream from GridFS.
        // The versioned route is a separate path rather than a query param.
        const downloadPath =
          versionId === undefined
            ? `/api/v2/documents/${documentId}/download`
            : `/api/v2/documents/${documentId}/download/${versionId}`;
        const response = (await apiFetch(downloadPath, {
          params: { scopeId },
          rawResponse: true,
        })) as Response;
        const buffer = Buffer.from(await response.arrayBuffer());

        // Guard: if GridFS returns an empty or trivially small body, something is wrong
        if (buffer.length <= 4) {
          const preview = buffer.toString('utf-8');
          if (preview === 'null' || preview === '') {
            // No metadata anywhere AND no content: the ID is likely invalid.
            // Common cause: passing an evidenceLinkId (an evidence join record)
            // instead of a documentId.
            if (details === null) {
              return toolError(
                `Document "${documentId}" not found in this scope. ` +
                  'If you obtained this ID from grc_controls_evidence, note that "evidenceLinkId" ' +
                  'is an evidence join record, not a document ID. To find the correct documentId, use ' +
                  'grc_documents_read list and filter by controlList[].controlId.',
              );
            }
            return toolError(
              `Document "${documentId}" exists but has no downloadable content (GridFS returned "${preview}"). ` +
                'The document record may be a stub without binary data.',
            );
          }
        }

        await writeFile(filePath, buffer);
        return toolResult({
          success: true,
          message: `Downloaded to ${filePath}`,
          bytes: buffer.length,
          source: 'gridfs',
        });
      } catch (error: unknown) {
        return toolError(`Document ${method} failed: ${getErrorMessage(error)}${remediationHint(error)}`);
      }
    },
  );

  // ── Write (Tier 2) ──────────────────────────────────────────
  server.registerTool(
    'grc_documents_write',
    {
      description:
        'Mutate documents. Use "upload" to upload a file from disk as a new document, ' +
        'or "update" to modify document metadata (title, description). ' +
        'Use grc_documents_read to list or download documents. Use grc_documents_delete to permanently remove.' +
        '\n\nPREFER "upload". It takes a local filePath and moves the bytes for you. "upload_url" and ' +
        '"upload_status" exist so this tool matches the hosted gateway, which has no filesystem: they hand ' +
        'back an upload URL for the CALLER to PUT to, then a completion signal to poll. That URL is served by ' +
        'the FortMesa MCP gateway files proxy (https://mcp.fortmesa.com/files/…) and is reachable with your ' +
        'normal HTTP client — no S3 access needed — and is time-limited, with its own "expiresAt". Reach for ' +
        'them only when the bytes are not on this machine.' +
        '\n\nUPLOAD stores the file under filePath\'s local basename by default; pass "fileName" to store ' +
        'it under a different name instead (both the returned "title" and the server-side gridfsFileName ' +
        'follow "fileName" when given). Must be a plain file name, not a path.' +
        '\n\nUPLOAD IS NOT ALWAYS A NEW DOCUMENT: the server de-duplicates by (stored) filename, so uploading ' +
        'under the same filename in the same scope adds a version to the existing document ' +
        'rather than creating a second one — the response carries the SAME "id" as the first upload and ' +
        '"versionCount" increases. There is no way to force a second document with the same filename; ' +
        'upload under a different filename if you need a separate record. Maximum file size is 50 MB.' +
        '\n\nReturns JSON. ' +
        'upload: { "id": "...", "title": "filename.pdf", "fileSize": 12345, "createdAt": "...", "versionCount": 2 } ' +
        'where "title" is the stored document name, "fileSize" is the size in bytes of the local file that ' +
        'was sent, and "versionCount" is the number of stored file versions after this upload. The server ' +
        'writes the version asynchronously (~100 ms), so this tool polls briefly (up to 2 s) for it; on the ' +
        'rare occasion the write has not landed in time "versionCount" is 0 — that does NOT mean the upload ' +
        'failed, call grc_documents_read list to confirm. ' +
        'upload_url: { "documentId": "...", "uploadUrl": "https://...", "method": "PUT", "expiresAt": "..." } ' +
        'upload_status: { "documentId": "...", "status": "...", "finished": bool, "complete": bool } ' +
        'update: true (the API returns a bare boolean, not an object)' +
        '\n\nUPDATE takes title and/or description directly; pass at least one. Any other field is set at ' +
        'creation and cannot be changed.',
      ...writeTool('Manage Documents'),
      inputSchema: {
        method: z.enum(['upload', 'upload_url', 'upload_status', 'update']).describe('Operation to perform'),
        scopeId: z.string().min(1).describe('Security scope ID'),
        documentId: z.string().min(1).optional().describe('Document ID (required for update and upload_status)'),
        filePath: z.string().optional().describe('Local file path to upload (required for upload)'),
        fileName: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Name to store the file under (required for upload_url; optional for upload — when supplied, ' +
              "overrides the local file's basename as the stored title/gridfsFileName; falls back to the " +
              'basename when omitted). Must be a plain file name, not a path.',
          ),
        contentLength: z
          .number()
          .optional()
          .describe('upload_url: size in bytes, if known. Checked against the 50 MB ceiling before a URL is issued'),
        title: z.string().optional().describe('update only: replaces the document title'),
        description: z
          .string()
          .optional()
          .describe('upload_url: optional description for the new document. update: replaces the description'),
        waitForIngest: z
          .boolean()
          .optional()
          .describe(
            'upload_status only: poll until the document completes or the wait budget runs out, instead of ' +
              'returning the current state once',
          ),
      },
    },
    async (
      { method, scopeId, documentId, filePath, fileName, contentLength, title, description, waitForIngest },
      ctx,
    ) => {
      try {
        // FORKLIFT-LANDED: scope-lock enforcement now lives here by design.
        getLock().assertAuthorized(scopeId);
        // `upload` stays local: it reads a path and posts the bytes as
        // multipart, which keeps the gzip envelope and the progress clock a
        // presigned PUT would lose. Everything else is relayed.
        if (method !== 'upload') {
          return await relay('grc_documents_write', {
            method,
            scopeId,
            ...(documentId !== undefined ? { documentId } : {}),
            ...(fileName !== undefined ? { fileName } : {}),
            ...(contentLength !== undefined ? { contentLength } : {}),
            ...(title !== undefined ? { title } : {}),
            ...(description !== undefined ? { description } : {}),
            ...(waitForIngest !== undefined ? { waitForIngest } : {}),
          });
        }
        // `method` is narrowed to 'upload' by the relay guard above.
        requireParam('filePath', filePath);
        const fileBuffer = await readFile(filePath);

        // Honour a caller-supplied `fileName` — the multipart field's filename is what
        // fmweb-be stores as `originalname` (document.service.ts:847), so this is the ONE
        // place that decides the stored title/gridfsFileName. Falls back to the local
        // basename when omitted, matching the gateway's upload_url path (documents.ts:275),
        // which also treats fileName as a plain stored name, not a path.
        // (non-empty is already enforced by the schema's z.string().min(1))
        let uploadFileName = basename(filePath);
        if (fileName !== undefined) {
          if (fileName.includes('/') || fileName.includes('\\')) {
            return toolError(`"fileName" must be a plain file name, not a path: "${fileName}"`);
          }
          uploadFileName = fileName;
        }

        // Build multipart form data
        const formData = new FormData();
        const blob = new Blob([fileBuffer]);
        formData.append('file', blob, uploadFileName);

        // gzip the envelope when the content compresses. A large CSV is the
        // case this exists for: the transfer, not the server, is what makes
        // it slow. fmweb-be inflates before multer, so the stored file is
        // byte-identical either way.
        const upload = await buildUploadBody(formData);

        // `replaceFile` is a DEAD parameter that the API nevertheless demands.
        // fmweb-be declares it required:true (document.controller.ts:519) and threads it
        // into uploadDocument (:527), but the service NEVER reads it: the de-duplication at
        // document.service.ts:645-652 matches on gridfsFileName/title + scope
        // unconditionally, so `true` and `false` behave identically (verified 2026-09-04 —
        // two uploads with replaceFile omitted returned the same document id and two
        // fileVersions). It is therefore NOT exposed on this tool: a flag that is never
        // read cannot be trusted wrongly. We send the constant the API requires.
        // Keep the client's request clock alive. The SDK cancels at 60s by
        // default and a 50MB upload can need more than that in transfer
        // alone; the spec lets a client reset that clock on progress
        // "as this implies that work is actually happening".
        //
        // `progress` counts elapsed seconds because that is the only
        // honest number available: the body goes out as one fetch() with
        // a FormData payload, which reports no bytes-sent. It rises
        // monotonically, as the spec requires, and `total` is omitted
        // rather than guessed so no client renders a fake percentage.
        const startedAt = Date.now();
        const heartbeat = setInterval(() => {
          const elapsed = Math.round((Date.now() - startedAt) / 1000);
          void ctx.reportProgress(elapsed, `Uploading ${uploadFileName} (${String(elapsed)}s)`);
        }, PROGRESS_INTERVAL_MS);
        // Never let the ticker alone hold the event loop open.
        heartbeat.unref();

        let uploaded: Record<string, unknown>;
        try {
          uploaded = (await apiFetch('/api/v2/documents', {
            method: 'POST',
            params: {
              scopeId,
              replaceFile: 'false',
            },
            rawBody: upload.body,
            headers: upload.headers,
            // The only call here that pushes a large body, so the only
            // one whose budget is set by upstream bandwidth rather than by
            // server latency. The API accepts files up to 50MB; at 5 Mbps
            // up that is 80s of transfer alone, and the server then stores
            // it before replying. Matches the 300s the "generate" poll
            // below allows. Only reachable when the client honours the
            // progress notifications above and extends past its own 60s.
            timeoutMs: 300_000,
          })) as Record<string, unknown>;
        } finally {
          clearInterval(heartbeat);
        }

        const id = uploaded.id;
        return toolResult({
          id,
          // BE returns `docName`; list/get already rename it to `title` at this boundary.
          title: uploaded.docName ?? uploaded.title,
          // The BE emits no fileSize on any /v2/documents mapper — compute it locally
          // from the bytes we just sent.
          fileSize: fileBuffer.length,
          createdAt: uploaded.createdAt,
          versionCount: await countVersions(scopeId, id, uploaded.fileVersions),
        });
      } catch (error: unknown) {
        return toolError(`Document ${method} failed: ${getErrorMessage(error)}${remediationHint(error)}`);
      }
    },
  );

  // ── Delete (Tier 3 — Erase) ─────────────────────────────────
  server.registerTool(
    'grc_documents_delete',
    {
      description:
        'Delete a document. There is NO separate archive step and no "archive" method on ' +
        'grc_documents_write — deletion is two-phase on the server and driven entirely by calling ' +
        'this tool: the FIRST call soft-deletes the document and archives every evidence link ' +
        'pointing at it (the document stops appearing in lists and in control evidence); a SECOND ' +
        'call on the same documentId permanently erases the record, its evidence links and its ' +
        'binary content from storage. The second call is irreversible. ' +
        'Use grc_documents_read to verify the document exists before deleting.' +
        '\n\nReturns JSON. ' +
        'true (the API returns a bare boolean, not an object)',
      ...writeTool('Delete Document'),
      inputSchema: {
        scopeId: z.string().min(1).describe('Security scope ID'),
        documentId: z.string().min(1).describe('Document ID of the document to delete'),
      },
    },
    async ({ scopeId, documentId }) => {
      try {
        // FORKLIFT-LANDED: scope-lock enforcement now lives here by design.
        getLock().assertAuthorized(scopeId);
        // Nothing local about a delete; the gateway owns it outright.
        return await relay('grc_documents_delete', { scopeId, documentId });
      } catch (error: unknown) {
        return toolError(`Document delete failed: ${getErrorMessage(error)}${remediationHint(error)}`);
      }
    },
  );
}
