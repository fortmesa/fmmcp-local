#!/usr/bin/env node
/**
 * test-runner.mjs — fmmcp-local end-to-end test runner.
 *
 * Full-chain test:  this runner ↔ [stdio] ↔ fmmcp-local proxy ↔ [streamable
 * HTTP + bearer] ↔ fmmcp-gw (spawned here on :3021) ↔ Continurisk API.
 *
 * All 16 tools are exercised: 13 proxied through the gateway, 3 documents
 * tools served locally by the proxy (path-based file I/O).
 *
 * Prereqs: fmmcp-gw built at ../fmmcp-gw (dist present); credentials for
 * --env in ~/.fmcode/credentials.json.
 *
 * Usage:
 *   yarn build && yarn node scripts/test-runner.mjs --env sandbox
 *
 * Output:
 *   /tmp/mcp-local-test-results.json — full results with response shapes
 *   stdout — pass/fail summary
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ── Environment (CLI: --env sandbox|next, default sandbox) ──
const ENV = process.argv.includes('--env') ? process.argv[process.argv.indexOf('--env') + 1] : 'sandbox';

const HTTP_PORT = 3021; // gateway spawned here; off 3020 to avoid a dev sidecar

// ── Environment capability matrix ───────────────────────────
// The sandbox pod has no S3/ephemeral storage (known limitation, confirmed
// 2026-07-03): system-doc GENERATION creates records but their content is not
// retrievable there. Gen→download is only testable against next/latest —
// next.fort.blue is the preferred mutation target (all changes temporary).
const ENV_CAPS = { sandbox: { sysDocContent: false } };
const CAPS = { sysDocContent: true, ...(ENV_CAPS[ENV] ?? {}) };
const GATEWAY_REPO = '/workspaces/fmmcp-gw';

// The three documents tools must be served LOCALLY by the proxy.
const DOC_TOOLS = new Set(['grc_documents_read', 'grc_documents_write', 'grc_documents_delete']);

// Scope split: vulns on aws-test, everything else on barsoommsp
const SCOPE_ID = '5da7314e388a0c6302e1f776'; // barsoommsp — controls, assets, plans, docs
const VULN_SCOPE = '6273e7e77c9998008f6a8e89'; // aws-test — vulnerability data
const CATALOG_ID = 'cisv8.1';
const CONTROL_ID = '1.1';
const CONTROL_ID_ALT = '1.2';
const KNOWN_FINDING_ID = '67f6fe93347eab005af2f55a'; // aws-test vuln

// State captured between tests
const state = {};
const results = [];

function describeShape(val, depth = 0) {
  if (val === null) return 'null';
  if (val === undefined) return 'undefined';
  if (Array.isArray(val)) {
    if (val.length === 0) return 'array(0)';
    return `array(${val.length})[${describeShape(val[0], depth + 1)}]`;
  }
  if (typeof val === 'object') {
    if (depth > 2) return `object(${Object.keys(val).length} keys)`;
    const keys = Object.keys(val);
    const inner = keys.slice(0, 8).map((k) => `${k}:${describeShape(val[k], depth + 1)}`);
    if (keys.length > 8) inner.push(`…+${keys.length - 8}`);
    return `{${inner.join(', ')}}`;
  }
  return typeof val;
}

function topLevelKeys(val) {
  if (Array.isArray(val) && val.length > 0) return Object.keys(val[0]);
  if (typeof val === 'object' && val !== null) return Object.keys(val);
  return [];
}

/** Call an MCP tool and return the parsed response data. */
async function callMcp(client, toolName, args) {
  const result = await client.callTool({ name: toolName, arguments: args });

  // MCP returns content array; first text element is JSON
  const textContent = result.content?.find((c) => c.type === 'text');
  if (!textContent) throw new Error('No text content in response');

  // Check for tool-level error
  if (result.isError) throw new Error(textContent.text);

  return JSON.parse(textContent.text);
}

async function test(client, id, name, toolName, args) {
  const t0 = Date.now();
  try {
    const response = await callMcp(client, toolName, args);
    const elapsed = Date.now() - t0;
    const entry = {
      id,
      name,
      toolName,
      args,
      status: 'PASS',
      elapsed,
      shape: describeShape(response),
      topKeys: topLevelKeys(response),
      isArray: Array.isArray(response),
      count: Array.isArray(response) ? response.length : null,
      sample: null,
    };
    // Capture first item (truncated strings)
    const sample = Array.isArray(response) ? response[0] : response;
    if (sample) {
      entry.sample = JSON.parse(
        JSON.stringify(sample, (k, v) => {
          if (typeof v === 'string' && v.length > 200) return v.slice(0, 200) + '…';
          return v;
        }),
      );
    }
    results.push(entry);
    process.stdout.write(`  ✅ #${String(id).padStart(2)} ${name} (${elapsed}ms)\n`);
    return response;
  } catch (err) {
    const elapsed = Date.now() - t0;
    results.push({ id, name, toolName, args, status: 'FAIL', elapsed, error: err.message });
    process.stdout.write(`  ❌ #${String(id).padStart(2)} ${name} — ${err.message.slice(0, 120)} (${elapsed}ms)\n`);
    return null;
  }
}

function skip(id, name, reason) {
  results.push({ id, name, status: 'SKIP', reason });
  process.stdout.write(`  ⏭️ #${String(id).padStart(2)} ${name} — SKIP (${reason})\n`);
}

/** Like test(), but PASSES when the call is rejected (negative coverage). */
async function testExpectError(client, id, name, toolName, args) {
  const t0 = Date.now();
  try {
    await callMcp(client, toolName, args);
    const elapsed = Date.now() - t0;
    results.push({ id, name, toolName, args, status: 'FAIL', elapsed, error: 'Expected rejection but call succeeded' });
    process.stdout.write(`  ❌ #${String(id).padStart(2)} ${name} — expected rejection, got success (${elapsed}ms)\n`);
    return null;
  } catch (err) {
    const elapsed = Date.now() - t0;
    results.push({ id, name, toolName, args, status: 'PASS', elapsed, expectedError: err.message.slice(0, 200) });
    process.stdout.write(`  ✅ #${String(id).padStart(2)} ${name} — rejected as expected (${elapsed}ms)\n`);
    return err;
  }
}

/** Poll a health endpoint until it responds ok or the deadline passes. */
async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Gateway health check timed out after ${timeoutMs}ms at ${url}`);
}

async function run() {
  // ── Spawn the HTTP gateway, then the proxy on stdio ─────────
  console.log(`=== fmmcp-local Test Runner (env: ${ENV}) ===`);

  // The gateway holds no credentials (bearer pass-through) — it only needs the
  // upstream base URL. The PROXY resolves the bearer from ~/.fmcode itself.
  const credsRaw = JSON.parse(await readFile(join(homedir(), '.fmcode', 'credentials.json'), 'utf8'));
  const envBlock = credsRaw.environments?.[ENV];
  if (!envBlock) {
    console.error(`Environment "${ENV}" not found in ~/.fmcode/credentials.json`);
    process.exit(2);
  }

  console.log(`Spawning gateway on :${HTTP_PORT} (upstream: ${envBlock.fortmesa_api_base})...`);
  const gatewayChild = spawn('yarn', ['node', 'dist/server/index.js', '--http', '--port', String(HTTP_PORT)], {
    cwd: GATEWAY_REPO,
    env: { ...process.env, CONTINURISK_API_URL: envBlock.fortmesa_api_base },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  await waitForHealth(`http://localhost:${HTTP_PORT}/health`, 15000);

  console.log('Spawning fmmcp-local proxy via stdio...\n');
  const transport = new StdioClientTransport({
    command: 'yarn',
    args: ['node', 'dist/local-mcp/cli.js', '--env', ENV, '--gateway', `http://localhost:${HTTP_PORT}/mcp`],
    cwd: process.cwd(),
  });

  const client = new Client({ name: 'test-runner', version: '1.0.0' });
  await client.connect(transport);

  // Verify the merged tool surface: 13 proxied + 3 local documents = 16
  const tools = await client.listTools();
  const expectedToolCount = 16;
  const docNames = tools.tools.filter((t) => DOC_TOOLS.has(t.name)).length;
  const countOk = tools.tools.length === expectedToolCount && docNames === DOC_TOOLS.size;
  results.push({
    id: 0,
    name: 'tools_surface(proxy)',
    status: countOk ? 'PASS' : 'FAIL',
    ...(countOk
      ? {}
      : {
          error: `expected ${expectedToolCount} tools incl. ${DOC_TOOLS.size} documents tools, got ${tools.tools.length} (${docNames} documents)`,
        }),
  });
  console.log(
    `Connected: ${tools.tools.length} tools (expected ${expectedToolCount}; local documents: ${docNames}/3) ${countOk ? '✅' : '❌'}\n`,
  );

  // ──────────────────────────────────────────
  // TIER 1 — READ OPERATIONS
  // ──────────────────────────────────────────
  console.log('--- Tier 1: Read Operations ---\n');

  // grc_scopes
  await test(client, 1, 'scopes.list', 'grc_scopes', { method: 'list' });
  await test(client, 2, 'scopes.get', 'grc_scopes', { method: 'get', scopeId: SCOPE_ID });
  await test(client, 3, 'scopes.list_users', 'grc_scopes', { method: 'list_users', scopeId: SCOPE_ID });

  // grc_plans
  const plans = await test(client, 4, 'plans.list_plans', 'grc_plans', { method: 'list_plans', scopeId: SCOPE_ID });
  if (plans && Array.isArray(plans) && plans.length > 0) {
    state.planId = plans[0]._id || plans[0].id;
    state.profileId = plans[0].controlProfileId || plans[0].profileId;
  }

  await test(client, 5, 'plans.get_plan', 'grc_plans', {
    method: 'get_plan',
    scopeId: SCOPE_ID,
    planId: state.planId || 'unknown',
  });

  await test(client, 6, 'plans.get_profile', 'grc_plans', {
    method: 'get_profile',
    scopeId: SCOPE_ID,
    profileId: state.profileId || 'unknown',
  });

  // grc_controls_read — list × 4 stages
  for (const [num, stage] of [
    [7, 'gap'],
    [8, 'implementation'],
    [9, 'policy'],
    [10, 'assessment'],
  ]) {
    await test(client, num, `controls_read.list(${stage})`, 'grc_controls_read', {
      method: 'list',
      stage,
      scopeId: SCOPE_ID,
    });
  }

  // grc_controls_read — get × 4 stages
  for (const [num, stage] of [
    [11, 'gap'],
    [12, 'implementation'],
    [13, 'policy'],
    [14, 'assessment'],
  ]) {
    await test(client, num, `controls_read.get(${stage})`, 'grc_controls_read', {
      method: 'get',
      stage,
      scopeId: SCOPE_ID,
      controlCatalogId: CATALOG_ID,
      controlId: CONTROL_ID,
    });
  }

  // grc_assets_read — assetType is now a REQUIRED enum; type-less list must be rejected
  await testExpectError(client, 15, 'assets_read.list(no_type)_rejected', 'grc_assets_read', {
    method: 'list',
    scopeId: SCOPE_ID,
  });

  const devices = await test(client, 16, 'assets_read.list(device)', 'grc_assets_read', {
    method: 'list',
    scopeId: SCOPE_ID,
    assetType: 'device',
  });
  // Capture a device ID and groupAssetIds for create+get tests
  if (devices && Array.isArray(devices) && devices.length > 0) {
    state.knownAssetId = devices[0]._id || devices[0].id;
    state.knownGroupAssetIds = devices[0].groupAssetIds || [];
  }

  await test(client, 17, 'assets_read.list(software)', 'grc_assets_read', {
    method: 'list',
    scopeId: SCOPE_ID,
    assetType: 'software',
  });

  await test(client, 18, 'assets_read.list(data)', 'grc_assets_read', {
    method: 'list',
    scopeId: SCOPE_ID,
    assetType: 'data',
  });

  await test(client, 19, 'assets_read.list(third-party)', 'grc_assets_read', {
    method: 'list',
    scopeId: SCOPE_ID,
    assetType: 'third-party',
  });

  await test(client, 20, 'assets_read.list(device+pagination)', 'grc_assets_read', {
    method: 'list',
    scopeId: SCOPE_ID,
    assetType: 'device',
    skip: 0,
    limit: 2,
  });

  if (state.knownAssetId) {
    await test(client, 21, 'assets_read.get', 'grc_assets_read', {
      method: 'get',
      scopeId: SCOPE_ID,
      assetId: state.knownAssetId,
    });
  } else {
    skip(21, 'assets_read.get', 'No device found in scope');
  }

  // grc_vulnerabilities_read (aws-test scope)
  await test(client, 22, 'vulns_read.list(no_filter)', 'grc_vulnerabilities_read', {
    method: 'list',
    scopeId: VULN_SCOPE,
  });

  await test(client, 23, 'vulns_read.list(status)', 'grc_vulnerabilities_read', {
    method: 'list',
    scopeId: VULN_SCOPE,
    vulnerabilityStatus: 'unManaged',
  });

  await test(client, 24, 'vulns_read.list(minSeverity)', 'grc_vulnerabilities_read', {
    method: 'list',
    scopeId: VULN_SCOPE,
    minSeverity: 7,
  });

  await test(client, 25, 'vulns_read.list(assetId)', 'grc_vulnerabilities_read', {
    method: 'list',
    scopeId: VULN_SCOPE,
    assetId: '6273e908da778c006546513c',
  });

  await test(client, 26, 'vulns_read.list(cveId)', 'grc_vulnerabilities_read', {
    method: 'list',
    scopeId: VULN_SCOPE,
    cveId: 'CVE-2025-26603',
  });

  await test(client, 27, 'vulns_read.list(minEPSSScore)', 'grc_vulnerabilities_read', {
    method: 'list',
    scopeId: VULN_SCOPE,
    minEPSSScore: 0.5,
  });

  await test(client, 28, 'vulns_read.list(limit)', 'grc_vulnerabilities_read', {
    method: 'list',
    scopeId: VULN_SCOPE,
    limit: 5,
  });

  await test(client, 29, 'vulns_read.list(skip+limit)', 'grc_vulnerabilities_read', {
    method: 'list',
    scopeId: VULN_SCOPE,
    skip: 3,
    limit: 2,
  });

  await test(client, 30, 'vulns_read.list(grouped)', 'grc_vulnerabilities_read', {
    method: 'list',
    scopeId: VULN_SCOPE,
    vulnerabilityStatus: 'unManaged',
    minSeverity: 4,
    limit: 5,
  });

  await test(client, 31, 'vulns_read.get', 'grc_vulnerabilities_read', {
    method: 'get',
    scopeId: VULN_SCOPE,
    findingId: KNOWN_FINDING_ID,
  });

  // grc_documents_read
  const docs = await test(client, 32, 'documents_read.list', 'grc_documents_read', {
    method: 'list',
    scopeId: SCOPE_ID,
  });

  if (docs && Array.isArray(docs) && docs.length > 0) {
    const uploaded = docs.find((d) => d._id || d.id);
    state.documentId = uploaded ? uploaded._id || uploaded.id : null;
  }

  if (state.documentId) {
    await test(client, 33, 'documents_read.get', 'grc_documents_read', {
      method: 'get',
      scopeId: SCOPE_ID,
      documentId: state.documentId,
    });
  } else {
    skip(33, 'documents_read.get', 'No uploaded doc found');
  }

  // #34-35 — Generate system doc then download it
  const generated = await test(client, 34, 'documents_read.generate(vulnCsv)', 'grc_documents_read', {
    method: 'generate',
    scopeId: SCOPE_ID,
    documentType: 'vulnerabilityCsvReport',
    documentFormat: 'csv',
  });
  state.generatedDocId = generated?.id || generated?._id;

  if (!CAPS.sysDocContent) {
    skip(
      35,
      'documents_read.download(generated)',
      `env "${ENV}" has no S3/ephemeral storage — gen→download needs next/latest`,
    );
  } else if (state.generatedDocId) {
    const genDownloadPath = '/tmp/mcp-test-generated-download.csv';
    await test(client, 35, 'documents_read.download(generated)', 'grc_documents_read', {
      method: 'download',
      scopeId: SCOPE_ID,
      documentId: state.generatedDocId,
      filePath: genDownloadPath,
    });
  } else {
    skip(35, 'documents_read.download(generated)', 'No doc from #34');
  }

  // Ensure control 1.2 has deployment state (GW returns empty if missing, but let's seed it)
  await callMcp(client, 'grc_controls_gap', {
    scopeId: SCOPE_ID,
    controlCatalogId: CATALOG_ID,
    controlId: CONTROL_ID_ALT,
    isDeployed: null,
  }).catch(() => {
    /* best effort */
  });

  await test(client, 36, 'evidence.list(1.1)', 'grc_controls_evidence', {
    method: 'list',
    scopeId: SCOPE_ID,
    controlCatalogId: CATALOG_ID,
    controlId: CONTROL_ID,
  });

  await test(client, 37, 'evidence.list(1.2)', 'grc_controls_evidence', {
    method: 'list',
    scopeId: SCOPE_ID,
    controlCatalogId: CATALOG_ID,
    controlId: CONTROL_ID_ALT,
  });

  // grc_controls_read (stage: comments)
  await test(client, 38, 'comments.list(control)', 'grc_controls_read', {
    method: 'list',
    stage: 'comments',
    scopeId: SCOPE_ID,
    controlCatalogId: CATALOG_ID,
    controlId: CONTROL_ID,
  });

  await test(client, 39, 'comments.list(alt_control)', 'grc_controls_read', {
    method: 'list',
    stage: 'comments',
    scopeId: SCOPE_ID,
    controlCatalogId: CATALOG_ID,
    controlId: CONTROL_ID_ALT,
  });

  // ──────────────────────────────────────────
  // TIER 2 — WRITE OPERATIONS
  // ──────────────────────────────────────────
  console.log('\n--- Tier 2: Write Operations ---\n');

  // grc_controls_gap (idempotent)
  await test(client, 40, 'controls_gap.set(true)', 'grc_controls_gap', {
    scopeId: SCOPE_ID,
    controlCatalogId: CATALOG_ID,
    controlId: CONTROL_ID,
    isDeployed: true,
  });

  await test(client, 41, 'controls_gap.set(false)', 'grc_controls_gap', {
    scopeId: SCOPE_ID,
    controlCatalogId: CATALOG_ID,
    controlId: CONTROL_ID,
    isDeployed: false,
  });

  await test(client, 42, 'controls_gap.set(null)', 'grc_controls_gap', {
    scopeId: SCOPE_ID,
    controlCatalogId: CATALOG_ID,
    controlId: CONTROL_ID,
    isDeployed: null,
  });

  // grc_controls_implementation (idempotent)
  await test(client, 43, 'controls_impl.state_only', 'grc_controls_implementation', {
    scopeId: SCOPE_ID,
    controlCatalogId: CATALOG_ID,
    controlId: CONTROL_ID,
    implementationState: 'most',
  });

  await test(client, 44, 'controls_impl.solutions_only', 'grc_controls_implementation', {
    scopeId: SCOPE_ID,
    controlCatalogId: CATALOG_ID,
    controlId: CONTROL_ID,
    solutions: ['AWS Config'],
  });

  await test(client, 45, 'controls_impl.not_applicable', 'grc_controls_implementation', {
    scopeId: SCOPE_ID,
    controlCatalogId: CATALOG_ID,
    controlId: CONTROL_ID,
    implementationState: 'not_applicable',
  });

  await test(client, 46, 'controls_impl.grouped', 'grc_controls_implementation', {
    scopeId: SCOPE_ID,
    controlCatalogId: CATALOG_ID,
    controlId: CONTROL_ID,
    implementationState: 'most',
    solutions: ['AWS Config', 'Inspector'],
  });

  // grc_controls_policy (idempotent)
  await test(client, 47, 'controls_policy.set', 'grc_controls_policy', {
    scopeId: SCOPE_ID,
    controlCatalogId: CATALOG_ID,
    controlId: CONTROL_ID,
    status: 'created',
  });

  await test(client, 48, 'controls_policy.reset', 'grc_controls_policy', {
    scopeId: SCOPE_ID,
    controlCatalogId: CATALOG_ID,
    controlId: CONTROL_ID,
    status: 'unknown',
  });

  // grc_controls_assessment (idempotent)
  await test(client, 49, 'controls_assessment.partial', 'grc_controls_assessment', {
    scopeId: SCOPE_ID,
    controlCatalogId: CATALOG_ID,
    controlId: CONTROL_ID,
    implementation: 'all',
  });

  await test(client, 50, 'controls_assessment.reset', 'grc_controls_assessment', {
    scopeId: SCOPE_ID,
    controlCatalogId: CATALOG_ID,
    controlId: CONTROL_ID,
    automation: 'none',
    reporting: 'none',
  });

  await test(client, 51, 'controls_assessment.grouped', 'grc_controls_assessment', {
    scopeId: SCOPE_ID,
    controlCatalogId: CATALOG_ID,
    controlId: CONTROL_ID,
    implementation: 'all',
    automation: 'some',
    reporting: 'none',
  });

  // grc_controls_comments CRUD
  const comment1 = await test(client, 52, 'comments.create(Comment+impl)', 'grc_controls_comments_write', {
    method: 'create',
    scopeId: SCOPE_ID,
    controlCatalogId: CATALOG_ID,
    controlId: CONTROL_ID,
    type: 'Comment',
    controlCommentSubtype: 'implementation',
    comment: '[MCP-TEST] Implementation note',
  });
  state.commentId1 = comment1?._id || comment1?.id;

  await test(client, 53, 'comments.create(Comment+policy)', 'grc_controls_comments_write', {
    method: 'create',
    scopeId: SCOPE_ID,
    controlCatalogId: CATALOG_ID,
    controlId: CONTROL_ID,
    type: 'Comment',
    controlCommentSubtype: 'policy',
    comment: '[MCP-TEST] Policy note',
  });

  await test(client, 54, 'comments.create(Comment+assessment)', 'grc_controls_comments_write', {
    method: 'create',
    scopeId: SCOPE_ID,
    controlCatalogId: CATALOG_ID,
    controlId: CONTROL_ID,
    type: 'Comment',
    controlCommentSubtype: 'assessment',
    comment: '[MCP-TEST] Assessment note',
  });

  await test(client, 55, 'comments.create(Question)', 'grc_controls_comments_write', {
    method: 'create',
    scopeId: SCOPE_ID,
    controlCatalogId: CATALOG_ID,
    controlId: CONTROL_ID,
    type: 'Question',
    controlCommentSubtype: 'implementation',
    comment: '[MCP-TEST] Is this done?',
  });

  await test(client, 56, 'comments.create(Assessor_statement)', 'grc_controls_comments_write', {
    method: 'create',
    scopeId: SCOPE_ID,
    controlCatalogId: CATALOG_ID,
    controlId: CONTROL_ID,
    type: 'Assessor statement',
    controlCommentSubtype: 'assessment',
    comment: '[MCP-TEST] Verified',
  });

  if (state.commentId1) {
    await test(client, 57, 'comments.update', 'grc_controls_comments_write', {
      method: 'update',
      scopeId: SCOPE_ID,
      commentId: state.commentId1,
      comment: '[MCP-TEST] Updated note',
    });

    await test(client, 58, 'comments.delete', 'grc_controls_comments_write', {
      method: 'delete',
      scopeId: SCOPE_ID,
      commentId: state.commentId1,
    });
  } else {
    skip(57, 'comments.update', 'No comment ID from #52');
    skip(58, 'comments.delete', 'No comment ID from #52');
  }

  // grc_controls_evidence — link/unlink
  if (state.documentId) {
    // For user-uploaded docs: send documentId ONLY (no documentType).
    // The BE service uses findById(documentId) path when documentType is absent.
    const linked = await test(client, 59, 'evidence.link(implementation)', 'grc_controls_evidence', {
      method: 'link',
      scopeId: SCOPE_ID,
      controlCatalogId: CATALOG_ID,
      controlId: CONTROL_ID,
      dimension: 'implementation',
      documentId: state.documentId,
    });
    // link response is raw BE shape (evidenceId); list responses are GW-renamed (evidenceLinkId)
    state.evidenceLinkId = linked?.evidenceLinkId || linked?.evidenceId || linked?._id || linked?.id;

    await test(client, 60, 'evidence.link(policy)', 'grc_controls_evidence', {
      method: 'link',
      scopeId: SCOPE_ID,
      controlCatalogId: CATALOG_ID,
      controlId: CONTROL_ID,
      dimension: 'policy',
      documentId: state.documentId,
    });

    await test(client, 61, 'evidence.link(assessment)', 'grc_controls_evidence', {
      method: 'link',
      scopeId: SCOPE_ID,
      controlCatalogId: CATALOG_ID,
      controlId: CONTROL_ID,
      dimension: 'assessment',
      documentId: state.documentId,
    });

    // Unlink uses evidenceLinkId (the join record from link/list), NOT documentId
    if (state.evidenceLinkId) {
      await test(client, 62, 'evidence.unlink(implementation)', 'grc_controls_evidence', {
        method: 'unlink',
        scopeId: SCOPE_ID,
        controlCatalogId: CATALOG_ID,
        controlId: CONTROL_ID,
        dimension: 'implementation',
        evidenceLinkId: state.evidenceLinkId,
      });
    } else {
      skip(62, 'evidence.unlink(implementation)', 'No evidenceLinkId from #59');
    }

    // Cleanup other links (best effort) — need evidence IDs from evidence list
    try {
      const evList = await callMcp(client, 'grc_controls_evidence', {
        method: 'list',
        scopeId: SCOPE_ID,
        controlCatalogId: CATALOG_ID,
        controlId: CONTROL_ID,
      });
      const allEvIds = [];
      for (const key of ['policyFiles', 'assessmentFiles', 'implementationFiles']) {
        for (const ev of evList?.[key] || []) {
          if (ev.evidenceLinkId && ev.documentId === state.documentId)
            allEvIds.push({ dim: key.replace('Files', ''), id: ev.evidenceLinkId });
        }
      }
      for (const { dim, id } of allEvIds) {
        await callMcp(client, 'grc_controls_evidence', {
          method: 'unlink',
          scopeId: SCOPE_ID,
          controlCatalogId: CATALOG_ID,
          controlId: CONTROL_ID,
          dimension: dim,
          evidenceLinkId: id,
        }).catch(() => {});
      }
    } catch {
      /* best effort */
    }
  } else {
    for (const id of [59, 60, 61, 62]) skip(id, 'evidence.link/unlink', 'No uploaded doc');
  }

  // grc_assets_write CRUD
  // BE requires assetLabel + groupAssetIds (non-empty — references asset group/logical containers)
  const groupIds = state.knownGroupAssetIds?.length ? state.knownGroupAssetIds : null;
  if (groupIds) {
    const newAsset = await test(client, 63, 'assets_write.create(device)', 'grc_assets_write', {
      method: 'create',
      scopeId: SCOPE_ID,
      assetType: 'device',
      data: {
        assetLabel: 'mcp-test-device-001',
        deviceId: 'mcp-test-device-001',
        operatingSystem: 'Ubuntu 24.04',
        deviceType: 'Virtual Machine',
        groupAssetIds: groupIds,
      },
    });
    // Gateway normalizes: id=parent Assets._id (consistent with list/get)
    state.newAssetId = newAsset?.id || newAsset?._id;

    const newSWAsset = await test(client, 64, 'assets_write.create(software)', 'grc_assets_write', {
      method: 'create',
      scopeId: SCOPE_ID,
      assetType: 'software',
      data: {
        assetLabel: 'mcp-test-pkg-1.0.0',
        name: 'mcp-test-pkg',
        version: '1.0.0',
        publisher: 'TestVendor',
        groupAssetIds: groupIds,
      },
    });
    state.newSWAssetId = newSWAsset?.id || newSWAsset?._id;
  } else {
    skip(63, 'assets_write.create(device)', 'No groupAssetIds from device list');
    skip(64, 'assets_write.create(software)', 'No groupAssetIds from device list');
  }

  if (state.newAssetId) {
    await test(client, 65, 'assets_write.update', 'grc_assets_write', {
      method: 'update',
      scopeId: SCOPE_ID,
      assetType: 'device',
      assetId: state.newAssetId,
      data: { operatingSystem: 'Ubuntu 24.10', assetLabel: 'mcp-test-device-001-updated', groupAssetIds: groupIds },
    });

    await test(client, 66, 'assets_write.remove(device)', 'grc_assets_write', {
      method: 'remove',
      scopeId: SCOPE_ID,
      assetId: state.newAssetId,
    });
  } else {
    skip(65, 'assets_write.update', 'No asset from #63');
    skip(66, 'assets_write.remove(device)', 'No asset from #63');
  }

  if (state.newSWAssetId) {
    await test(client, 67, 'assets_write.remove(software)', 'grc_assets_write', {
      method: 'remove',
      scopeId: SCOPE_ID,
      assetId: state.newSWAssetId,
    });
  } else {
    skip(67, 'assets_write.remove(software)', 'No asset from #64');
  }

  // grc_vulnerabilities_write CRUD (aws-test — create, mutate, then destroy our data)
  const newVuln = await test(client, 68, 'vulns_write.create', 'grc_vulnerabilities_write', {
    method: 'create',
    scopeId: VULN_SCOPE,
    data: {
      findingId: 'MCP-TEST-001',
      assetId: '6273e908da778c006546513c',
      assetType: 'device',
      title: '[MCP-TEST] Test vulnerability',
      numericSeverity: 5.0,
      vulnerabilityStatus: 'unManaged',
      dataSource: 'manual',
    },
  });
  state.newFindingId = newVuln?._id || newVuln?.id;

  if (state.newFindingId) {
    await test(client, 69, 'vulns_write.update(single)', 'grc_vulnerabilities_write', {
      method: 'update',
      scopeId: VULN_SCOPE,
      findingId: state.newFindingId,
      data: {
        findingId: 'MCP-TEST-001',
        assetId: '6273e908da778c006546513c',
        assetType: 'device',
        vulnerabilityStatus: 'reviewTechnical',
      },
    });

    await test(client, 70, 'vulns_write.update(multi)', 'grc_vulnerabilities_write', {
      method: 'update',
      scopeId: VULN_SCOPE,
      findingId: state.newFindingId,
      data: {
        findingId: 'MCP-TEST-001',
        assetId: '6273e908da778c006546513c',
        assetType: 'device',
        numericSeverity: 7.5,
        vulnerabilityStatus: 'reviewRisk',
      },
    });

    await test(client, 71, 'vulns_write.remove', 'grc_vulnerabilities_write', {
      method: 'remove',
      scopeId: VULN_SCOPE,
      findingId: state.newFindingId,
    });
  } else {
    for (const id of [69, 70, 71]) skip(id, 'vulns_write.*', 'No finding from #68');
  }
  // ──────────────────────────────────────────
  // DOCUMENT LIFECYCLE — upload, download, archive, delete
  // ──────────────────────────────────────────

  // Create a small test file on disk
  const testFilePath = '/tmp/mcp-test-upload.txt';
  const testFileContent = `[MCP-TEST] Gateway upload test — ${new Date().toISOString()}`;
  await writeFile(testFilePath, testFileContent);

  const uploaded = await test(client, 72, 'documents_write.upload', 'grc_documents_write', {
    method: 'upload',
    scopeId: SCOPE_ID,
    filePath: testFilePath,
  });
  state.uploadedDocId = uploaded?.id || uploaded?._id;

  if (state.uploadedDocId) {
    // Download the uploaded doc (GridFS path)
    const downloadPath = '/tmp/mcp-test-download.txt';
    await test(client, 73, 'documents_read.download(uploaded)', 'grc_documents_read', {
      method: 'download',
      scopeId: SCOPE_ID,
      documentId: state.uploadedDocId,
      filePath: downloadPath,
    });

    // Verify downloaded content matches
    const { readFile: readF } = await import('node:fs/promises');
    try {
      const downloaded = await readF(downloadPath, 'utf-8');
      if (downloaded.includes('[MCP-TEST]')) {
        console.log('  ✅ Download content verified');
      } else {
        console.log(`  ⚠️  Download content mismatch (got ${downloaded.length} bytes)`);
      }
    } catch (e) {
      console.log(`  ⚠️  Could not verify download: ${e.message}`);
    }

    // Delete the test doc (DELETE is archive+remove in one)
    await test(client, 74, 'documents_delete(uploaded)', 'grc_documents_delete', {
      scopeId: SCOPE_ID,
      documentId: state.uploadedDocId,
    });
  } else {
    skip(73, 'documents_read.download(uploaded)', 'No doc from #72');
    skip(74, 'documents_delete(uploaded)', 'No doc from #72');
  }

  // Download the generated doc (presigned URL path)
  if (!CAPS.sysDocContent) {
    skip(
      75,
      'documents_read.download(generated_sys)',
      `env "${ENV}" has no S3/ephemeral storage — gen→download needs next/latest`,
    );
  } else if (state.generatedDocId) {
    const sysDownloadPath = '/tmp/mcp-test-generated-download.bin';
    await test(client, 75, 'documents_read.download(generated_sys)', 'grc_documents_read', {
      method: 'download',
      scopeId: SCOPE_ID,
      documentId: state.generatedDocId,
      filePath: sysDownloadPath,
    });
  } else {
    skip(75, 'documents_read.download(generated_sys)', 'No generated doc from #34');
  }

  // ──────────────────────────────────────────
  // TIER 3 — GAP COVERAGE (missing method/param paths)
  // ──────────────────────────────────────────
  console.log('\n--- Tier 3: Gap Coverage ---\n');

  // T76: evidence stage was REMOVED from controls_read (moved to grc_controls_evidence).
  // Negative coverage: the old call shape must now be rejected by input validation.
  await testExpectError(client, 76, 'controls_read.stage(evidence)_rejected', 'grc_controls_read', {
    method: 'get',
    stage: 'evidence',
    scopeId: SCOPE_ID,
    controlCatalogId: CATALOG_ID,
    controlId: CONTROL_ID,
  });

  await test(client, 77, 'controls_read.get(comments)', 'grc_controls_read', {
    method: 'get',
    stage: 'comments',
    scopeId: SCOPE_ID,
    controlCatalogId: CATALOG_ID,
    controlId: CONTROL_ID,
  });

  // T78-79: controls_policy — approved and none (only created/unknown were tested)
  await test(client, 78, 'controls_policy.approved', 'grc_controls_policy', {
    scopeId: SCOPE_ID,
    controlCatalogId: CATALOG_ID,
    controlId: CONTROL_ID_ALT,
    status: 'approved',
  });

  await test(client, 79, 'controls_policy.none', 'grc_controls_policy', {
    scopeId: SCOPE_ID,
    controlCatalogId: CATALOG_ID,
    controlId: CONTROL_ID_ALT,
    status: 'none',
  });

  // T80: comments — Management statement type (only Comment/Question/Assessor were tested)
  const mgmtComment = await test(client, 80, 'comments.create(Mgmt_statement)', 'grc_controls_comments_write', {
    method: 'create',
    scopeId: SCOPE_ID,
    controlCatalogId: CATALOG_ID,
    controlId: CONTROL_ID,
    type: 'Management statement',
    controlCommentSubtype: 'assessment',
    comment: '[MCP-TEST] Management response',
  });
  state.mgmtCommentId = mgmtComment?._id || mgmtComment?.id;

  // T81: comments — threaded reply (respondedId param — never tested)
  if (state.mgmtCommentId) {
    await test(client, 81, 'comments.create(threaded_reply)', 'grc_controls_comments_write', {
      method: 'create',
      scopeId: SCOPE_ID,
      controlCatalogId: CATALOG_ID,
      controlId: CONTROL_ID,
      type: 'Comment',
      controlCommentSubtype: 'assessment',
      comment: '[MCP-TEST] Reply to mgmt',
      respondedId: state.mgmtCommentId,
    });
  } else {
    skip(81, 'comments.create(threaded_reply)', 'No mgmt comment from #80');
  }

  // T82: evidence — link with documentType (system-generated doc, not user-uploaded)
  await test(client, 82, 'evidence.link(documentType)', 'grc_controls_evidence', {
    method: 'link',
    scopeId: SCOPE_ID,
    controlCatalogId: CATALOG_ID,
    controlId: CONTROL_ID_ALT,
    dimension: 'implementation',
    documentId: 'placeholder',
    documentType: 'assetInventoryReport-device',
  });

  // T83-86: assets_write.create — data, third-party, and auto-default-group (never tested)
  const newDataAsset = await test(client, 83, 'assets_write.create(data)', 'grc_assets_write', {
    method: 'create',
    scopeId: SCOPE_ID,
    assetType: 'data',
    data: {
      assetLabel: 'mcp-test-data-001',
      dataAssetName: 'test-db',
      dataAssetLocation: 'us-east-1',
      groupAssetIds: groupIds || undefined,
    },
  });
  state.newDataAssetId = newDataAsset?.id || newDataAsset?._id;

  const new3PAsset = await test(client, 84, 'assets_write.create(third-party)', 'grc_assets_write', {
    method: 'create',
    scopeId: SCOPE_ID,
    assetType: 'third-party',
    data: {
      assetLabel: 'mcp-test-vendor',
      assetName: 'TestVendor Corp',
      assetAdditionalInfo: 'SaaS',
      groupAssetIds: groupIds || undefined,
    },
  });
  state.new3PAssetId = new3PAsset?.id || new3PAsset?._id;

  // T85: auto-default-group — create device WITHOUT groupAssetIds (NEW FEATURE)
  const autoGroupAsset = await test(client, 85, 'assets_write.create(auto_default_group)', 'grc_assets_write', {
    method: 'create',
    scopeId: SCOPE_ID,
    assetType: 'device',
    data: {
      assetLabel: 'mcp-test-auto-dg',
      deviceId: 'mcp-auto-dg',
      deviceType: 'Virtual Machine',
      deviceName: 'auto-default-group-test',
    },
  });
  state.autoGroupAssetId = autoGroupAsset?.id || autoGroupAsset?._id;

  // Cleanup: archive the new assets
  for (const [id, label, assetId] of [
    [86, 'remove(data)', state.newDataAssetId],
    [87, 'remove(third-party)', state.new3PAssetId],
    [88, 'remove(auto-dg)', state.autoGroupAssetId],
  ]) {
    if (assetId) {
      await test(client, id, `assets_write.${label}`, 'grc_assets_write', {
        method: 'remove',
        scopeId: SCOPE_ID,
        assetId,
      });
    } else {
      skip(id, `assets_write.${label}`, 'No asset from create');
    }
  }

  // T89: documents_write.update (metadata — title/description change)
  if (state.documentId) {
    await test(client, 89, 'documents_write.update(metadata)', 'grc_documents_write', {
      method: 'update',
      scopeId: SCOPE_ID,
      documentId: state.documentId,
      data: { title: '[MCP-TEST] Renamed doc', description: 'Updated by test runner' },
    });
  } else {
    skip(89, 'documents_write.update(metadata)', 'No uploaded doc');
  }

  // ──────────────────────────────────────────
  // CLEANUP test comments (best effort)
  // ──────────────────────────────────────────
  console.log('\n--- Cleanup ---\n');
  const cleanupComments = await callMcp(client, 'grc_controls_read', {
    method: 'list',
    stage: 'comments',
    scopeId: SCOPE_ID,
    controlCatalogId: CATALOG_ID,
    controlId: CONTROL_ID,
  }).catch(() => []);

  if (Array.isArray(cleanupComments)) {
    let cleaned = 0;
    for (const c of cleanupComments) {
      const text = c.comment || c.text || '';
      if (text.startsWith('[MCP-TEST]')) {
        try {
          await callMcp(client, 'grc_controls_comments_write', {
            method: 'delete',
            scopeId: SCOPE_ID,
            commentId: c._id || c.id,
          });
          cleaned++;
        } catch {
          /* best effort */
        }
      }
    }
    console.log(`  Cleaned ${cleaned} test comments`);
  }

  // ──────────────────────────────────────────
  // SUMMARY
  // ──────────────────────────────────────────
  console.log('\n--- Summary ---\n');

  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const skipCount = results.filter((r) => r.status === 'SKIP').length;

  console.log(`  PASS: ${pass}  FAIL: ${fail}  SKIP: ${skipCount}  TOTAL: ${results.length}`);

  if (fail > 0) {
    console.log('\nFailed tests:');
    for (const r of results.filter((r) => r.status === 'FAIL')) {
      console.log(`  #${r.id} ${r.name}: ${r.error}`);
    }
  }

  // Write full results
  await writeFile('/tmp/mcp-local-test-results.json', JSON.stringify(results, null, 2));
  console.log('\nFull results: /tmp/mcp-local-test-results.json');

  // Disconnect
  await client.close();
  if (gatewayChild) {
    gatewayChild.kill('SIGTERM');
  }
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Fatal:', err);
  process.exit(2);
});
