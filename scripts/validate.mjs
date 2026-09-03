#!/usr/bin/env node
/**
 * Validates the catalog content against the metadata contract the site relies on.
 *
 *   node scripts/validate.mjs            # check manifest.json, every plugin.json, and Hosted artifacts
 *   node scripts/validate.mjs --fetch    # also fetch every External downloadUrl and check its header
 *   node scripts/validate.mjs --root <dir> --repo owner/repo
 *
 * Exit code 1 on any error. Bad optional fields are warnings; everything else is an error.
 * No dependencies; Node 20 or newer.
 */
import { readFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { argv, exit } from 'node:process';

const args = argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const ROOT = resolve(option('--root', '.'));
const REPOSITORY = option('--repo', 'goproslowyo/bd-plugins');
const FETCH = flag('--fetch');

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const RAW_INSIDE = `https://raw.githubusercontent.com/${REPOSITORY}/`;
const ALLOWLISTED_HOSTS = ['raw.githubusercontent.com'];
const META_TAGS = ['@name', '@author', '@description', '@version'];

const isHttps = (v) => typeof v === 'string' && /^https:\/\/[^\s/]+/.test(v);
const isAllowlistedHost = (v) => {
  if (!isHttps(v)) return false;
  try {
    return ALLOWLISTED_HOSTS.includes(new URL(v).hostname);
  } catch {
    return false;
  }
};
const isRealDate = (v) => {
  if (typeof v !== 'string') return false;
  const m = ISO_DATE.exec(v);
  if (!m) return false;
  const [, y, mo, d] = m.map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
};
const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Optional keys: how each must look when present. */
const OPTIONAL = {
  status: { ok: (v) => typeof v === 'string', want: 'a string' },
  workingStatus: { ok: (v) => typeof v === 'string', want: 'a string' },
  lastUpdated: { ok: isRealDate, want: 'a real YYYY-MM-DD date' },
  releaseDate: { ok: isRealDate, want: 'a real YYYY-MM-DD date' },
  features: { ok: isStringArray, want: 'an array of strings' },
  requirements: { ok: isStringArray, want: 'an array of strings' },
  tags: { ok: isStringArray, want: 'an array of strings' },
  sourceUrl: { ok: isHttps, want: 'an https URL' },
  changelogUrl: { ok: isHttps, want: 'an https URL' },
  downloadUrl: { ok: isHttps, want: 'an https URL' },
  issuesUrl: { ok: isHttps, want: 'an https URL' },
  versionUrl: { ok: isHttps, want: 'an https URL' },
  icon: { ok: isAllowlistedHost, want: 'an https URL on raw.githubusercontent.com' },
  pinnedUrl: { ok: (v) => isAllowlistedHost(v) && /\/[0-9a-f]{7,40}\//.test(v), want: 'an https URL on raw.githubusercontent.com containing a commit sha segment' },
  license: { ok: (v) => typeof v === 'string', want: 'a string (SPDX id)' },
  featured: { ok: (v) => typeof v === 'boolean', want: 'a boolean' },
};

/** Header Check on artifact text: `/**` on line 1 and the four META tags before `*​/`. */
function checkMetaHeader(text) {
  const problems = [];
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  if (!firstLine.includes('/**')) problems.push('line 1 does not contain "/**"');
  const end = text.indexOf('*/');
  const header = end >= 0 ? text.slice(0, end) : '';
  if (end < 0) problems.push('no closing "*/" for the META header');
  for (const tag of META_TAGS) if (!header.includes(tag)) problems.push(`${tag} missing from the META header`);
  return problems;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** @returns {{ id: string, name: string, kind: string, errors: string[], warnings: string[] }} */
function result(id, name) {
  return { id, name, kind: '-', errors: [], warnings: [] };
}

async function main() {
  const results = [];
  const manifestResult = result('manifest.json', '');
  results.push(manifestResult);

  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(ROOT, 'manifest.json'), 'utf8'));
  } catch (err) {
    manifestResult.errors.push(`cannot read or parse manifest.json: ${err.message}`);
    return finish(results);
  }
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.plugins)) {
    manifestResult.errors.push('"plugins" must be an array');
    return finish(results);
  }

  const seenIds = new Set();
  const entries = [];
  manifest.plugins.forEach((entry, i) => {
    const label = entry && typeof entry.id === 'string' ? entry.id : `plugins[${i}]`;
    const r = result(label, entry && typeof entry.name === 'string' ? entry.name : '');
    results.push(r);
    if (!entry || typeof entry !== 'object') {
      r.errors.push('entry is not an object');
      return;
    }
    if (typeof entry.id !== 'string' || !SLUG.test(entry.id)) r.errors.push(`id must be a slug (^[a-z0-9]+(-[a-z0-9]+)*$), got ${JSON.stringify(entry.id)}`);
    if (typeof entry.name !== 'string' || entry.name === '') r.errors.push('name must be a non-empty string');
    if (typeof entry.enabled !== 'boolean') r.errors.push('enabled must be a boolean');
    if (typeof entry.id === 'string') {
      if (seenIds.has(entry.id)) r.errors.push(`duplicate id "${entry.id}"`);
      seenIds.add(entry.id);
    }
    if (r.errors.length === 0) entries.push({ entry, r });
  });

  for (const { entry, r } of entries) {
    if (!entry.enabled) {
      r.kind = 'disabled';
      continue;
    }
    const folder = join(ROOT, 'Plugins', entry.name);
    if (!(await exists(folder))) {
      r.errors.push(`folder Plugins/${entry.name}/ does not exist`);
      continue;
    }
    let meta;
    try {
      meta = JSON.parse(await readFile(join(folder, 'plugin.json'), 'utf8'));
    } catch (err) {
      r.errors.push(`plugin.json: ${err.code === 'ENOENT' ? 'missing' : `not valid JSON (${err.message})`}`);
      continue;
    }
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
      r.errors.push('plugin.json is not a JSON object');
      continue;
    }
    for (const key of ['name', 'description', 'version', 'author']) {
      if (!(key in meta) || meta[key] === null) r.errors.push(`required field "${key}" is missing`);
      else if (typeof meta[key] !== 'string') r.errors.push(`required field "${key}" must be a string, got ${typeof meta[key]}`);
    }
    for (const [key, rule] of Object.entries(OPTIONAL)) {
      if (key in meta && !rule.ok(meta[key])) r.warnings.push(`optional field "${key}" is not ${rule.want}; the site drops it`);
    }

    const download = isHttps(meta.downloadUrl) ? meta.downloadUrl : null;
    const hosted = download === null || download.startsWith(RAW_INSIDE);
    r.kind = hosted ? 'hosted' : 'external';
    if (!hosted && !isHttps(meta.sourceUrl)) r.errors.push('External entry: "sourceUrl" is required and must be an https URL');

    if (hosted) {
      const artifact = join(folder, `${entry.name}.plugin.js`);
      try {
        const text = await readFile(artifact, 'utf8');
        for (const p of checkMetaHeader(text)) r.errors.push(`${entry.name}.plugin.js: ${p}`);
      } catch {
        r.errors.push(`Hosted entry: Plugins/${entry.name}/${entry.name}.plugin.js is missing`);
      }
    } else if (FETCH) {
      try {
        const res = await fetch(download);
        if (!res.ok) r.errors.push(`downloadUrl answered ${res.status}`);
        else for (const p of checkMetaHeader(await res.text())) r.errors.push(`fetched artifact: ${p}`);
      } catch (err) {
        r.errors.push(`downloadUrl could not be fetched: ${err.message}`);
      }
    }
  }
  return finish(results);
}

function finish(results) {
  const pad = (s, n) => String(s).padEnd(n);
  const w = { id: Math.max(2, ...results.map((r) => r.id.length)), name: Math.max(4, ...results.map((r) => r.name.length)) };
  console.log(`${pad('id', w.id)}  ${pad('name', w.name)}  ${pad('kind', 8)}  status`);
  console.log(`${'-'.repeat(w.id)}  ${'-'.repeat(w.name)}  ${'-'.repeat(8)}  ------`);
  let errors = 0;
  let warnings = 0;
  for (const r of results) {
    const status = r.errors.length ? 'ERROR' : r.warnings.length ? 'warn' : 'ok';
    console.log(`${pad(r.id, w.id)}  ${pad(r.name, w.name)}  ${pad(r.kind, 8)}  ${status}`);
    for (const e of r.errors) console.log(`  ✖ ${e}`);
    for (const wn of r.warnings) console.log(`  ! ${wn}`);
    errors += r.errors.length;
    warnings += r.warnings.length;
  }
  console.log('');
  console.log(`${results.length - 1} entries, ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}${FETCH ? ' (external artifacts fetched)' : ''}`);
  exit(errors ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  exit(1);
});
