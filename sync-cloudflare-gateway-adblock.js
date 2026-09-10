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
const HAGEZI_LIST = process.env.HAGEZI_LIST || 'pro.txt';

// Hagezi's "domains" format lists — plain domain-per-line, no wildcard/
// adblock syntax, which is what Cloudflare Gateway domain lists expect.
// See https://github.com/hagezi/dns-blocklists for details on each tier.

const HAGEZI_LIST_BASE_URL = 'https://raw.githubusercontent.com/hagezi/dns-blocklists/refs/heads/main/adblock/';

const API_BATCH_SIZE = 10;
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

async function batchWithDelay(asyncFns, batchSize, delayMs) {
  const results = [];
  
  for (let i = 0; i < asyncFns.length; i += batchSize) {
    const batch = asyncFns.slice(i, i + batchSize);
    
    const batchPromises = batch.map(fn => fn());
    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);
    
    if (i + batchSize < asyncFns.length) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  
  return results;
}

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

function sanitizeDomain(line) {
  line = line.trim();
  if (!line || line.startsWith('[') || line.startsWith('!')) return null;

  if (line.startsWith('||')) line = line.slice(2);
  if (line.startsWith('|'))  line = line.slice(1);
  if (line.endsWith('^'))    line = line.slice(0, -1);

  return line;
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
    .map(sanitizeDomain)
    .filter(Boolean);
  console.log(`Downloaded ${domains.length} domains.`);
  return domains;
}

function chunkArray(array, size, maxNumOfChunks) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  if (chunks.length > maxNumOfChunks) {
    console.warn(
      `This blocklist needs ${chunks.length} lists of ${size} domains each, ` +
        `but the free-plan cap is ${maxNumOfChunks} lists.` +
        `The last ${chunks.length - maxNumOfChunks} chunk(s) shall be removed to allow for this.`
    );
    chunks.splice(maxNumOfChunks + 1);
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
  const url = HAGEZI_LIST_BASE_URL + HAGEZI_LIST;
  const domains = await downloadDomainList(url);
  
  console.log(`Splitting into ${domains.length} domains into lists of ${DOMAINS_PER_LIST} max.`);
  const chunks = chunkArray(domains, DOMAINS_PER_LIST, MAX_LISTS);

  // Snapshot the previous run's lists BEFORE creating new ones, so cleanup
  // never touches anything we're about to create.
  const staleLists = await getExistingManagedLists();
  console.log(`Found ${staleLists.length} list(s) from a previous run to clean up afterward.`);

  const runId = Date.now();
  const newListIds = await batchWithDelay(
    chunks.map((chunk, i) => {
      const name = `${LIST_NAME_PREFIX}${runId}-${String(i+1).padStart(3, '0')}-of-${chunks.length}`;
      return () => createList(name, chunk);
    }),
    API_BATCH_SIZE,
    1000
  );

  // Point the policy at the new lists BEFORE deleting the old ones, so
  // there's never a gap where filtering is broken mid-sync.
  await upsertPolicy(newListIds);

  await batchWithDelay(
    staleLists.map(old => { return () => deleteList(old.id, old.name); }),
    API_BATCH_SIZE,
    1000
  );

  console.log('Sync complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
