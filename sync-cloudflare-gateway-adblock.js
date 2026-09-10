#!/usr/bin/env node
/**
 * sync-cloudflare-gateway-adblock.js
 *
 * Downloads a Hagezi DNS blocklist and syncs it into Cloudflare Zero Trust
 * Gateway as domain lists + a single DNS "block" policy. Designed to run on
 * a schedule (e.g. GitHub Actions) and be safely re-run every time — each
 * run fully replaces the previous run's lists with a fresh copy.
 *
 * Requires Node.js 18+ (uses the built-in fetch API).
 *
 * Required environment variables:
 *   CF_ACCOUNT_ID  - your Cloudflare account ID
 *   CF_API_TOKEN   - an API token with Zero Trust > Gateway edit permission
 *
 * Optional environment variable:
 *   HAGEZI_LIST    - overrides the HAGEZI_LIST constant below
 */

// ====================== CONFIGURATION ======================

// Change this to switch blocklists, or override at runtime with the
// HAGEZI_LIST environment variable (handy for testing a different list
// without editing this file).
const HAGEZI_LIST = process.env.HAGEZI_LIST || 'pro';

// Hagezi's "domains" format lists — plain domain-per-line, no wildcard/
// adblock syntax, which is what Cloudflare Gateway domain lists expect.
// See https://github.com/hagezi/dns-blocklists for details on each tier.
const HAGEZI_LIST_URLS = {
  light: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/domains/light.txt',
  normal: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/domains/multi.txt',
  pro: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/domains/pro.txt',
  'pro-plus': 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/domains/pro.plus.txt',
  ultimate: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/domains/ultimate.txt',
};

const LIST_NAME_PREFIX = 'hagezi-adblock-'; // used to find + clean up our own lists
const POLICY_NAME = 'Block Ads & Trackers (Hagezi)';
const DOMAINS_PER_LIST = 1000; // Cloudflare's per-list item cap
const MAX_LISTS = 300; // Free-plan list cap — abort rather than exceed it

// ====================== END CONFIGURATION ======================

const ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const API_TOKEN = process.env.CF_API_TOKEN;

if (!ACCOUNT_ID || !API_TOKEN) {
  console.error('Missing required environment variables: CF_ACCOUNT_ID and/or CF_API_TOKEN.');
  process.exit(1);
}

const API_BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}`;

async function cfFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await res.json();
  if (!res.ok || data.success === false) {
    throw new Error(`Cloudflare API error on ${path}: ${JSON.stringify(data.errors || data)}`);
  }
  return data.result;
}

async function downloadDomainList(url) {
  console.log(`Downloading blocklist: ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download blocklist: ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  const domains = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  console.log(`Downloaded ${domains.length} domains.`);
  return domains;
}

function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

async function getExistingManagedLists() {
  const lists = await cfFetch('/gateway/lists');
  return lists.filter((l) => l.name.startsWith(LIST_NAME_PREFIX));
}

async function getExistingPolicy() {
  const policies = await cfFetch('/gateway/rules');
  return policies.find((p) => p.name === POLICY_NAME);
}

async function createList(name, domains) {
  console.log(`Creating list "${name}" (${domains.length} domains)...`);
  return cfFetch('/gateway/lists', {
    method: 'POST',
    body: JSON.stringify({
      name,
      type: 'DOMAIN',
      items: domains.map((value) => ({ value })),
    }),
  });
}

async function deleteList(listId, name) {
  console.log(`Deleting stale list "${name}"...`);
  await cfFetch(`/gateway/lists/${listId}`, { method: 'DELETE' });
}

async function upsertPolicy(listIds) {
  const traffic = listIds.map((id) => `any(dns.domains[*] in $${id})`).join(' or ');

  const body = {
    name: POLICY_NAME,
    description:
      `Auto-managed by sync-cloudflare-gateway-adblock.js. ` +
      `Blocklist: ${HAGEZI_LIST}. Do not edit manually — changes will be overwritten on the next run.`,
    enabled: true,
    action: 'block',
    filters: ['dns'],
    traffic,
  };

  const existing = await getExistingPolicy();
  if (existing) {
    console.log('Updating existing block policy...');
    await cfFetch(`/gateway/rules/${existing.id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  } else {
    console.log('Creating new block policy...');
    await cfFetch('/gateway/rules', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }
}

async function main() {
  const url = HAGEZI_LIST_URLS[HAGEZI_LIST];
  if (!url) {
    console.error(
      `Unknown HAGEZI_LIST "${HAGEZI_LIST}". Valid options: ${Object.keys(HAGEZI_LIST_URLS).join(', ')}`
    );
    process.exit(1);
  }

  const domains = await downloadDomainList(url);
  const chunks = chunkArray(domains, DOMAINS_PER_LIST);

  if (chunks.length > MAX_LISTS) {
    console.error(
      `This blocklist needs ${chunks.length} lists of ${DOMAINS_PER_LIST} domains each, ` +
        `but the free-plan cap is ${MAX_LISTS} lists. Pick a smaller HAGEZI_LIST ` +
        `(try "normal" or "light").`
    );
    process.exit(1);
  }

  console.log(`Splitting into ${chunks.length} list(s) of up to ${DOMAINS_PER_LIST} domains each.`);

  // Snapshot the previous run's lists BEFORE creating new ones, so cleanup
  // never touches anything we're about to create.
  const staleLists = await getExistingManagedLists();
  console.log(`Found ${staleLists.length} list(s) from a previous run to clean up afterward.`);

  const runId = Date.now();
  const newListIds = [];
  for (let i = 0; i < chunks.length; i++) {
    const name = `${LIST_NAME_PREFIX}${runId}-${String(i).padStart(3, '0')}`;
    const list = await createList(name, chunks[i]);
    newListIds.push(list.id);
  }

  // Point the policy at the new lists BEFORE deleting the old ones, so
  // there's never a gap where filtering is broken mid-sync.
  await upsertPolicy(newListIds);

  for (const old of staleLists) {
    await deleteList(old.id, old.name);
  }

  console.log('Sync complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
