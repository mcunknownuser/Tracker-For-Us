// =============================================================================
//  build-latest-json.mjs
//  Runs in the GitHub Actions "manifest" job after both arch builds have
//  uploaded their .app.tar.gz + .sig to the release. We:
//    1. Hit the GitHub Releases API for the tag we're building.
//    2. Find the asset URLs for the two .app.tar.gz archives.
//    3. Pull each .sig blob (a single base64 line) inline.
//    4. Write latest.json with both platforms and upload it as an asset
//       to the same release.
//  The in-app updater fetches this file from the release's "latest"
//  download URL and decides which platform's tarball to grab.
//
//  Env required (set automatically in release.yml):
//    GITHUB_TOKEN  — auth for the API (read assets, upload latest.json)
//    TAG           — e.g. "v0.1.2"
//    REPO          — e.g. "chew856/Tracker-For-Us"
// =============================================================================

import { writeFileSync, readFileSync } from 'node:fs';

const { GITHUB_TOKEN, TAG, REPO } = process.env;
if (!GITHUB_TOKEN || !TAG || !REPO) {
  console.error('Missing GITHUB_TOKEN, TAG, or REPO env');
  process.exit(1);
}

const api = (path) => `https://api.github.com/repos/${REPO}${path}`;
const headers = {
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'tauri-updater-manifest',
};

// 1. Look up the release for this tag.
const relRes = await fetch(api(`/releases/tags/${TAG}`), { headers });
if (!relRes.ok) {
  console.error('Failed to fetch release:', relRes.status, await relRes.text());
  process.exit(1);
}
const release = await relRes.json();

// 2. Match assets by suffix.
//    Tauri names them like:
//      darwin-aarch64 → VoltrisAi_<ver>_aarch64.app.tar.gz
//      darwin-x86_64  → VoltrisAi_<ver>_x64.app.tar.gz
//    (Plus matching .sig files.)
function findAsset(suffix) {
  return release.assets.find((a) => a.name.endsWith(suffix));
}

const platforms = {};
for (const [tauriKey, archSuffix] of [
  ['darwin-aarch64', 'aarch64.app.tar.gz'],
  ['darwin-x86_64', 'x64.app.tar.gz'],
]) {
  const tar = findAsset(archSuffix);
  const sig = findAsset(`${archSuffix}.sig`);
  if (!tar || !sig) {
    console.warn(`Skipping ${tauriKey} — missing asset (tar=${!!tar}, sig=${!!sig})`);
    continue;
  }
  // The .sig file is small (~100 bytes). Download it and inline as base64.
  const sigRes = await fetch(sig.browser_download_url);
  if (!sigRes.ok) {
    console.error('Failed to download sig:', sig.browser_download_url);
    process.exit(1);
  }
  const signature = (await sigRes.text()).trim();
  platforms[tauriKey] = {
    signature,
    url: tar.browser_download_url,
  };
}

if (Object.keys(platforms).length === 0) {
  console.error('No platform assets found — nothing to publish');
  process.exit(1);
}

const manifest = {
  version: TAG.startsWith('v') ? TAG.slice(1) : TAG,
  notes: release.body || 'New version available.',
  pub_date: release.published_at || new Date().toISOString(),
  platforms,
};

const out = JSON.stringify(manifest, null, 2);
writeFileSync('latest.json', out);
console.log('Generated latest.json:');
console.log(out);

// 3. Upload latest.json to the release. If one already exists (from a
//    re-run), delete it first so we can overwrite.
const existing = release.assets.find((a) => a.name === 'latest.json');
if (existing) {
  await fetch(api(`/releases/assets/${existing.id}`), {
    method: 'DELETE',
    headers,
  });
}

// Asset uploads use a separate upload host.
const uploadUrl = release.upload_url.replace('{?name,label}', '?name=latest.json');
const uploadRes = await fetch(uploadUrl, {
  method: 'POST',
  headers: {
    ...headers,
    'Content-Type': 'application/json',
  },
  body: readFileSync('latest.json'),
});
if (!uploadRes.ok) {
  console.error('Upload failed:', uploadRes.status, await uploadRes.text());
  process.exit(1);
}
console.log('Uploaded latest.json to release', TAG);
