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
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { exit } from 'node:process';
import { parseArgs } from 'node:util';

let opts;
try {
  opts = parseArgs({
    options: {
      root: { type: 'string', default: '.' },
      repo: { type: 'string', default: 'goproslowyo/bd-plugins' },
      fetch: { type: 'boolean', default: false },
    },
  }).values;
} catch (err) {
  console.error(`${err.message}\nusage: node scripts/validate.mjs [--root <dir>] [--repo owner/repo] [--fetch]`);
  exit(1);
}

const ROOT = resolve(opts.root);
const REPOSITORY = opts.repo;
const FETCH = opts.fetch;

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const FILENAME_STEM = /^[A-Za-z0-9._-]+$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const RAW_INSIDE = `https://raw.githubusercontent.com/${REPOSITORY}/`;
const ALLOWLISTED_HOSTS = ['raw.githubusercontent.com'];
const META_TAGS = ['@name', '@author', '@description', '@version'];
const HEADER_WINDOW = 1024;

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
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Optional keys: how each must look when present, and what the site does with a bad value. */
const DERIVED = 'the site treats it as absent and derives it for Hosted entries';
const DROPPED = 'the site treats it as absent';
const OPTIONAL = {
  status: { ok: (v) => typeof v === 'string', want: 'a string', then: DROPPED },
  workingStatus: { ok: (v) => typeof v === 'string', want: 'a string', then: DROPPED },
  lastUpdated: { ok: isRealDate, want: 'a real YYYY-MM-DD date', then: DROPPED },
  releaseDate: { ok: isRealDate, want: 'a real YYYY-MM-DD date', then: DROPPED },
  features: { ok: isStringArray, want: 'an array of strings', then: DROPPED },
  requirements: { ok: isStringArray, want: 'an array of strings', then: DROPPED },
  tags: { ok: isStringArray, want: 'an array of strings', then: DROPPED },
  sourceUrl: { ok: isHttps, want: 'an https URL', then: DERIVED },
  changelogUrl: { ok: isHttps, want: 'an https URL', then: DERIVED },
  downloadUrl: { ok: isHttps, want: 'an https URL', then: `${DERIVED}; the entry counts as Hosted` },
  issuesUrl: { ok: isHttps, want: 'an https URL', then: 'the site links to the catalog repository issues instead' },
  versionUrl: { ok: isHttps, want: 'an https URL', then: DROPPED },
  icon: { ok: isAllowlistedHost, want: 'an https URL on raw.githubusercontent.com', then: DROPPED },
  pinnedUrl: { ok: (v) => isAllowlistedHost(v) && /\/[0-9a-f]{7,40}\//.test(v), want: 'an https URL on raw.githubusercontent.com containing a commit sha segment', then: DROPPED },
  license: { ok: (v) => typeof v === 'string', want: 'a string (SPDX id)', then: DROPPED },
  featured: { ok: (v) => typeof v === 'boolean', want: 'a boolean', then: DROPPED },
};

/**
 * Header Check on artifact text. Line 1 must open the META comment and the four
 * META tags must appear before it closes; the site additionally looks for the
 * comment opener and @name within the first kilobyte only.
 */
function checkMetaHeader(text) {
  const problems = [];
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  if (!firstLine.includes('/**')) problems.push('line 1 does not contain "/**"');
  const end = text.indexOf('*/');
  const header = end >= 0 ? text.slice(0, end) : '';
  if (end < 0) problems.push('no closing "*/" for the META header');
  for (const tag of META_TAGS) if (!header.includes(tag)) problems.push(`${tag} missing from the META header`);
  const head = text.slice(0, HEADER_WINDOW);
  for (const mark of ['/**', '@name']) {
    if (text.includes(mark) && !head.includes(mark)) problems.push(`${mark} is not within the first ${HEADER_WINDOW} characters the site inspects`);
  }
  return problems;
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Reads a file and parses it as JSON, telling a read failure apart from a parse
 * failure. A leading byte order mark is skipped, as fetch() does for the site.
 */
async function readJson(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    return { error: `could not be read (${err.code ?? err.message})` };
  }
  try {
    return { value: JSON.parse(text.replace(/^\uFEFF/, '')) };
  } catch (err) {
    return { error: `is not valid JSON (${err.message})` };
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

  const manifest = await readJson(join(ROOT, 'manifest.json'));
  if (manifest.error) {
    manifestResult.errors.push(`manifest.json ${manifest.error}`);
    return finish(results, 0);
  }
  if (!manifest.value || typeof manifest.value !== 'object' || !Array.isArray(manifest.value.plugins)) {
    manifestResult.errors.push('"plugins" must be an array');
    return finish(results, 0);
  }

  const seenIds = new Set();
  const entries = [];
  let entryCount = 0;
  manifest.value.plugins.forEach((entry, i) => {
    entryCount += 1;
    const label = entry && typeof entry.id === 'string' ? entry.id : `plugins[${i}]`;
    const r = result(label, entry && typeof entry.name === 'string' ? entry.name : '');
    results.push(r);
    if (!entry || typeof entry !== 'object') {
      r.errors.push('entry is not an object');
      return;
    }
    if (typeof entry.id !== 'string' || !SLUG.test(entry.id)) r.errors.push(`id must be a slug (^[a-z0-9]+(-[a-z0-9]+)*$), got ${JSON.stringify(entry.id)}`);
    if (typeof entry.name !== 'string' || entry.name === '') r.errors.push('name must be a non-empty string');
    else if (!FILENAME_STEM.test(entry.name)) r.errors.push(`name must match ^[A-Za-z0-9._-]+$ (it becomes a folder, a filename and part of every derived URL), got ${JSON.stringify(entry.name)}`);
    if (typeof entry.enabled !== 'boolean') r.errors.push('enabled must be a boolean');
    if (typeof entry.id === 'string') {
      if (seenIds.has(entry.id)) r.errors.push(`duplicate id "${entry.id}"`);
      seenIds.add(entry.id);
    }
    if (r.errors.length === 0) entries.push({ entry, r });
  });

  /** Every spelling of each tag across the catalog, to catch case-only collisions. */
  const tagSpellings = new Map();

  for (const { entry, r } of entries) {
    if (!entry.enabled) {
      r.kind = 'disabled';
      continue;
    }
    const folder = join(ROOT, 'Plugins', entry.name);
    if (!(await isDirectory(folder))) {
      r.errors.push(`folder Plugins/${entry.name}/ does not exist`);
      continue;
    }
    const metaFile = await readJson(join(folder, 'plugin.json'));
    if (metaFile.error) {
      r.errors.push(`plugin.json ${metaFile.error}`);
      continue;
    }
    const meta = metaFile.value;
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
      r.errors.push('plugin.json is not a JSON object');
      continue;
    }
    for (const key of ['name', 'description', 'version', 'author']) {
      if (!(key in meta) || meta[key] === null) r.errors.push(`required field "${key}" is missing`);
      else if (typeof meta[key] !== 'string') r.errors.push(`required field "${key}" must be a string, got ${typeof meta[key]}`);
    }
    for (const [key, rule] of Object.entries(OPTIONAL)) {
      if (key in meta && !rule.ok(meta[key])) r.warnings.push(`optional field "${key}" is not ${rule.want}; ${rule.then}`);
    }
    if (isStringArray(meta.tags)) {
      for (const tag of meta.tags) {
        if (tag.trim() === '') r.warnings.push(`tag ${JSON.stringify(tag)} is empty; the site drops it`);
        else if (tag !== tag.trim()) r.warnings.push(`tag ${JSON.stringify(tag)} is padded with whitespace; the site trims it`);
        else {
          const key = tag.toLowerCase();
          if (!tagSpellings.has(key)) tagSpellings.set(key, new Map());
          const users = tagSpellings.get(key);
          if (!users.has(tag)) users.set(tag, []);
          users.get(tag).push(r);
        }
      }
    }

    const download = isHttps(meta.downloadUrl) ? meta.downloadUrl : null;
    const hosted = download === null || download.startsWith(RAW_INSIDE);
    r.kind = hosted ? 'hosted' : 'external';
    if (!hosted && !isHttps(meta.sourceUrl)) r.errors.push('External entry: "sourceUrl" is required and must be an https URL');
    if (!hosted && !isHttps(meta.issuesUrl)) r.warnings.push('External entry has no "issuesUrl"; the site would send issue reports to the catalog repository');

    if (hosted) {
      const artifact = `${entry.name}.plugin.js`;
      let text;
      try {
        text = await readFile(join(folder, artifact), 'utf8');
      } catch (err) {
        r.errors.push(`Hosted entry: Plugins/${entry.name}/${artifact} could not be read (${err.code ?? err.message})`);
        continue;
      }
      for (const p of checkMetaHeader(text)) r.errors.push(`${artifact}: ${p}`);
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

  for (const spellings of tagSpellings.values()) {
    if (spellings.size < 2) continue;
    for (const [tag, users] of spellings) {
      const others = [...spellings.keys()].filter((t) => t !== tag).map((t) => JSON.stringify(t)).join(', ');
      for (const r of users) r.warnings.push(`tag ${JSON.stringify(tag)} differs only by case from ${others} in the catalog; the site filters them as different tags`);
    }
  }
  return finish(results, entryCount);
}

function finish(results, entryCount) {
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
  console.log(`${plural(entryCount, 'entry', 'entries')}, ${plural(errors, 'error')}, ${plural(warnings, 'warning')}${FETCH ? ' (external artifacts fetched)' : ''}`);
  exit(errors ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  exit(1);
});
