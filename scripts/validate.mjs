#!/usr/bin/env node
/**
 * Validates the catalog content against the metadata contract the site relies on.
 *
 *   node scripts/validate.mjs            # check manifest.json, every plugin.json, and Hosted artifacts
 *   node scripts/validate.mjs --fetch    # also fetch every External downloadUrl and check its header
 *   node scripts/validate.mjs --root <dir> --repo owner/repo
 *
 * Exit code 1 on any error. Bad optional fields are warnings; everything else is an error.
 * A Hosted entry that records an "upstream" also has its fork-point facts checked
 * against the local git history (warnings only when git or the repository is missing).
 * No dependencies; Node 20 or newer.
 */
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { exit } from 'node:process';
import { parseArgs, promisify } from 'node:util';

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
const UPSTREAM_TREE_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/tree\/[^/]+\/Plugins\/[A-Za-z0-9._-]+$/;
const COMMIT_SHA = /^[0-9a-f]{7,40}$/;
const UPSTREAM_KEYS = ['url', 'version', 'commit', 'forkPoint'];

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

/**
 * What is wrong with an "upstream" value, if anything. The object is all-or-nothing
 * for the site, so one problem is enough to make it count as absent.
 */
function upstreamShapeProblems(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return ['not an object'];
  const problems = [];
  for (const key of UPSTREAM_KEYS) if (typeof v[key] !== 'string') problems.push(`"${key}" must be a string`);
  if (typeof v.url === 'string' && !UPSTREAM_TREE_URL.test(v.url)) problems.push('"url" must be a GitHub tree URL of the form https://github.com/{owner}/{repo}/tree/{ref}/Plugins/{name}');
  if (typeof v.version === 'string' && (v.version === '' || v.version !== v.version.trim())) problems.push('"version" must be a non-empty trimmed string');
  for (const key of ['commit', 'forkPoint']) if (typeof v[key] === 'string' && !COMMIT_SHA.test(v[key])) problems.push(`"${key}" must be 7 to 40 lowercase hex characters`);
  return problems;
}

/** The META @version declared in an artifact's header, or null. */
function metaVersion(text) {
  const end = text.indexOf('*/');
  const header = end >= 0 ? text.slice(0, end) : text.slice(0, HEADER_WINDOW);
  const m = /^\s*\*?\s*@version\s+(\S+)/m.exec(header);
  return m ? m[1] : null;
}

const execFileP = promisify(execFile);

/** Runs git in the root; { ok, stdout } or { ok: false, code } where code is the exit status or an errno string. */
async function git(...args) {
  try {
    const { stdout } = await execFileP('git', ['-C', ROOT, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return { ok: true, stdout };
  } catch (err) {
    return { ok: false, code: err.code ?? err.message };
  }
}

/** Whether the fact checks can run: 'ok', 'no-git' (not installed), or 'no-repo' (root is not a work tree). */
async function gitAvailability() {
  const res = await git('rev-parse', '--is-inside-work-tree');
  if (res.ok && res.stdout.trim() === 'true') return 'ok';
  return res.code === 'ENOENT' ? 'no-git' : 'no-repo';
}

/**
 * The fork-point facts for a well-formed "upstream" on a Hosted entry, as
 * errors: they are facts we own, and the site's links are wrong when they are false.
 */
async function checkUpstreamFacts(entry, upstream, r) {
  const path = `Plugins/${entry.name}/${entry.name}.plugin.js`;
  const { forkPoint, commit } = upstream;
  if (!(await git('cat-file', '-e', `${forkPoint}^{commit}`)).ok) {
    r.errors.push(`upstream.forkPoint ${forkPoint} does not resolve to a commit in this repository`);
  } else if (!(await git('merge-base', '--is-ancestor', forkPoint, 'HEAD')).ok) {
    r.errors.push(`upstream.forkPoint ${forkPoint} is not an ancestor of HEAD`);
  } else {
    const shown = await git('show', `${forkPoint}:${path}`);
    if (!shown.ok) {
      r.errors.push(`${path} does not exist at upstream.forkPoint ${forkPoint}`);
    } else {
      const version = metaVersion(shown.stdout);
      if (version !== upstream.version) r.errors.push(`${path} at upstream.forkPoint ${forkPoint} declares @version ${version ?? '(none)'}, but upstream.version is ${upstream.version}; the fork point must be a verbatim Upstream copy at that version`);
    }
  }
  if (!(await git('cat-file', '-e', `${commit}^{commit}`)).ok) {
    const remotes = await git('remote');
    const hasUpstreamRemote = remotes.ok && remotes.stdout.split(/\r?\n/).includes('upstream');
    if (hasUpstreamRemote) r.errors.push(`upstream.commit ${commit} is unknown locally; run \`git fetch upstream\``);
    else r.warnings.push(`could not verify upstream.commit ${commit}; no upstream remote`);
  }
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
  /** Looked up once, the first time an entry needs the fork-point facts. */
  let gitState = null;

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

    let upstream = null;
    if ('upstream' in meta) {
      const problems = upstreamShapeProblems(meta.upstream);
      if (problems.length) r.warnings.push(`optional field "upstream" is not well-formed (${problems.join('; ')}); the site treats it as absent and shows nothing about Upstream`);
      else if (!hosted) r.warnings.push('External entry carries "upstream"; the site ignores it, External entries are their own Upstream');
      else upstream = meta.upstream;
      if (meta.upstream && typeof meta.upstream === 'object' && !Array.isArray(meta.upstream)) {
        for (const key of Object.keys(meta.upstream)) if (!UPSTREAM_KEYS.includes(key)) r.warnings.push(`"upstream" has an unknown member "${key}"; the site ignores it`);
      }
    }

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
      if (upstream) {
        gitState ??= await gitAvailability();
        if (gitState === 'ok') await checkUpstreamFacts(entry, upstream, r);
        else r.warnings.push(`could not verify upstream facts: ${gitState === 'no-git' ? 'git is not installed' : 'not a git repository'}`);
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
