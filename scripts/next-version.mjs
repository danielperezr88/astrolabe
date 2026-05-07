#!/usr/bin/env node
/**
 * next-version.mjs — Calculate the next release version.
 *
 * Usage:
 *   node scripts/next-version.mjs --rc        # Print next RC version (e.g. 0.2.0-rc.3)
 *   node scripts/next-version.mjs --release   # Print stable version from latest RC (e.g. 0.2.0)
 *   node scripts/next-version.mjs --current   # Print current stable version (e.g. 0.1.0)
 *
 * Version strategy:
 *   - Latest stable tag determines the base (e.g. v0.1.0)
 *   - Next RC = minor bump from latest stable (e.g. v0.2.0-rc.1)
 *   - Subsequent RCs increment the suffix (e.g. v0.2.0-rc.2)
 *   - Release strips the -rc.N suffix (e.g. v0.2.0)
 *   - If a pre-created tag like v2.0.0-rc.seed exists, it seeds that major version
 *
 * Works both locally (git CLI) and in CI (GitHub Actions).
 */

import { execFileSync } from 'node:child_process';

// ── Helpers ────────────────────────────────────────────────────────────────

function git(...args) {
  try {
    return execFileSync('git', args, { encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

function getTags() {
  const output = git('tag', '-l', 'v*');
  if (!output) return [];
  return output
    .split('\n')
    .map((t) => t.trim())
    .filter(Boolean)
    .sort(compareSemver);
}

function parseTag(tag) {
  // v1.2.3-rc.4 → { major:1, minor:2, patch:3, rc:4, stable:true }
  // v1.2.3      → { major:1, minor:2, patch:3, rc:0, stable:true }
  const m = tag.match(/^v(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+|seed))?$/);
  if (!m) return null;
  return {
    major: parseInt(m[1], 10),
    minor: parseInt(m[2], 10),
    patch: parseInt(m[3], 10),
    rc: m[4] === 'seed' ? 0 : (m[4] ? parseInt(m[4], 10) : 0),
    isRC: m[4] !== undefined,
    tag,
  };
}

function compareSemver(a, b) {
  const pa = parseTag(a);
  const pb = parseTag(b);
  if (!pa && !pb) return 0;
  if (!pa) return 1;
  if (!pb) return -1;
  const diff = pa.major - pb.major || pa.minor - pb.minor || pa.patch - pb.patch || pa.rc - pb.rc;
  return diff;
}

function versionString(major, minor, patch, rc) {
  const base = `${major}.${minor}.${patch}`;
  if (rc > 0) return `${base}-rc.${rc}`;
  return base;
}

// ── Main logic ─────────────────────────────────────────────────────────────

function getLatestStable(tags) {
  const stable = tags
    .map(parseTag)
    .filter((t) => t && !t.isRC)
    .sort((a, b) => compareSemver(a.tag, b.tag));
  return stable.length > 0 ? stable[stable.length - 1] : null;
}

function getLatestRC(tags) {
  const rcs = tags
    .map(parseTag)
    .filter((t) => t && t.isRC && t.rc > 0)
    .sort((a, b) => compareSemver(a.tag, b.tag));
  return rcs.length > 0 ? rcs[rcs.length - 1] : null;
}

function checkSeedTag(tags) {
  // A seed tag like v2.0.0-rc.seed indicates a major version bump intent
  const seeds = tags
    .map(parseTag)
    .filter((t) => t && t.isRC && t.rc === 0);
  if (seeds.length === 0) return null;
  // Use the highest seed
  return seeds.sort((a, b) => compareSemver(a.tag, b.tag)).pop();
}

function nextRC(tags) {
  const latestRC = getLatestRC(tags);
  if (latestRC) {
    // An RC cycle is already in progress — increment
    return versionString(latestRC.major, latestRC.minor, latestRC.patch, latestRC.rc + 1);
  }

  const seed = checkSeedTag(tags);
  if (seed) {
    // A seed tag exists (e.g. v2.0.0-rc.seed) and no real RC yet — use seed as base
    return versionString(seed.major, seed.minor, seed.patch, 1);
  }

  const latestStable = getLatestStable(tags);
  // No RC in progress — start a new minor bump from latest stable
  const base = latestStable || { major: 0, minor: 0, patch: 0 };
  return versionString(base.major, base.minor + 1, 0, 1);
}

function nextRelease(tags) {
  const seed = checkSeedTag(tags);
  const latestRC = getLatestRC(tags);
  let major, minor, patch;

  if (latestRC) {
    // Strip the -rc.N suffix
    major = latestRC.major;
    minor = latestRC.minor;
    patch = latestRC.patch;
  } else if (seed) {
    // A seed tag exists but no real RC yet — use seed as base
    major = seed.major;
    minor = seed.minor;
    patch = seed.patch;
  } else {
    // No RC exists — shouldn't normally happen, but fallback to next minor from stable
    const latestStable = getLatestStable(tags);
    const base = latestStable || { major: 0, minor: 0, patch: 0 };
    major = base.major;
    minor = base.minor + 1;
    patch = 0;
  }

  // If a stable tag with this version already exists, bump the patch
  const stableTags = new Set(
    tags
      .map(parseTag)
      .filter((t) => t && !t.isRC)
      .map((t) => versionString(t.major, t.minor, t.patch, 0)),
  );

  let version = versionString(major, minor, patch, 0);
  while (stableTags.has(version)) {
    patch++;
    version = versionString(major, minor, patch, 0);
  }

  return version;
}

function currentStable(tags) {
  const latest = getLatestStable(tags);
  if (latest) return versionString(latest.major, latest.minor, latest.patch, 0);
  return '0.0.0';
}

// ── CLI ────────────────────────────────────────────────────────────────────

const mode = process.argv[2];
const tags = getTags();

switch (mode) {
  case '--rc':
    console.log(nextRC(tags));
    break;
  case '--release':
    console.log(nextRelease(tags));
    break;
  case '--current':
    console.log(currentStable(tags));
    break;
  default:
    console.error('Usage: node scripts/next-version.mjs --rc|--release|--current');
    process.exit(1);
}
