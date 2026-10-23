'use strict';
/*
 * Ask the registry (Docker Hub, ghcr.io, lscr.io, quay.io …) for the newest digest of an image tag.
 * With a HEAD request: nothing is downloaded and Docker Hub doesn't count it towards the rate limit.
 * Signing in is anonymous, with the token the registry itself points to (WWW-Authenticate).
 */
const crypto = require('node:crypto');

const ACCEPT = [
  'application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json', 'application/vnd.oci.image.manifest.v1+json',
].join(', ');

// "jellyfin/jellyfin:latest" → { registry: 'registry-1.docker.io', repo: 'jellyfin/jellyfin', tag: 'latest' }
function parseRef(ref) {
  let name = String(ref || '').trim();
  if (!name || name.includes('@') || name.startsWith('sha256:')) return null; // pinned to a digest: no updates
  let tag = 'latest';
  const colon = name.lastIndexOf(':'), slash = name.lastIndexOf('/');
  if (colon > slash) { tag = name.slice(colon + 1); name = name.slice(0, colon); }
  const first = name.split('/')[0];
  let registry = 'registry-1.docker.io', repo = name;
  if (name.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost')) { registry = first; repo = name.slice(first.length + 1); }
  if (registry === 'docker.io' || registry === 'index.docker.io') registry = 'registry-1.docker.io';
  if (registry === 'registry-1.docker.io' && !repo.includes('/')) repo = 'library/' + repo;
  return { registry, repo: repo.toLowerCase(), tag };
}

function authParams(header) {
  return Object.fromEntries([...String(header || '').matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
}

// A request to the registry, with the anonymous token if the registry asks for it (once per repository).
function client(r, timeout) {
  const headers = {};
  return async function req(path, { method = 'GET', accept = ACCEPT } = {}) {
    const url = `https://${r.registry}/v2/${r.repo}/${path}`;
    const go = () => fetch(url, { method, headers: { ...headers, Accept: accept }, redirect: 'follow', signal: AbortSignal.timeout(timeout) });
    let res = await go();
    if (res.status === 401 && !headers.Authorization) {
      const p = authParams(res.headers.get('www-authenticate'));
      if (!p.realm) throw new Error('the registry asks for a sign-in');
      const u = new URL(p.realm);
      if (p.service) u.searchParams.set('service', p.service);
      u.searchParams.set('scope', p.scope || `repository:${r.repo}:pull`);
      const t = await fetch(u, { signal: AbortSignal.timeout(timeout) });
      if (!t.ok) throw new Error(t.status === 401 || t.status === 403 ? 'private image, sign-in is not set up' : 'signing in to the registry failed (' + t.status + ')');
      const j = await t.json();
      headers.Authorization = 'Bearer ' + (j.token || j.access_token);
      res = await go();
    }
    if (res.status === 404) throw new Error('this tag does not exist (anymore) in the registry');
    if (res.status === 401 || res.status === 403) throw new Error('private image, sign-in is not set up');
    if (res.status === 429) throw new Error('the registry asks to wait a moment (too many requests)');
    if (!res.ok) throw new Error('the registry returned error ' + res.status);
    return res;
  };
}

async function remoteDigest(ref, { timeout = 15000 } = {}) {
  const r = parseRef(ref);
  if (!r) return null;
  const req = client(r, timeout), path = 'manifests/' + encodeURIComponent(r.tag);
  const res = await req(path, { method: 'HEAD' });
  const digest = res.headers.get('docker-content-digest');
  if (digest) return digest;
  // Some registries give no digest on HEAD: then fetch the manifest and hash it ourselves.
  const body = Buffer.from(await (await req(path)).arrayBuffer());
  return 'sha256:' + crypto.createHash('sha256').update(body).digest('hex');
}

// Pick the right manifest for this server from a list of manifests (multi-arch).
function pickManifest(index, arch) {
  const list = (index && index.manifests) || [];
  const linux = list.filter((m) => m.platform && m.platform.os === 'linux');
  return linux.find((m) => m.platform.architecture === arch) || null;
}

// What the image itself reports: ports (EXPOSE), folders (VOLUME), variables, labels. Without downloading the image.
async function imageConfig(ref, { arch = 'amd64', timeout = 20000 } = {}) {
  const r = parseRef(ref);
  if (!r) throw new Error('this is not a valid image name');
  const req = client(r, timeout);
  let man = await (await req('manifests/' + encodeURIComponent(r.tag))).json();
  if (man.manifests) {
    const m = pickManifest(man, arch);
    if (!m) throw new Error(`this image does not exist for this server (${arch})`);
    man = await (await req('manifests/' + m.digest)).json();
  }
  if (!man.config || !man.config.digest) throw new Error('this image\'s manifest has no configuration');
  const cfg = await (await req('blobs/' + man.config.digest, { accept: '*/*' })).json();
  return { ref: r, config: cfg.config || {} };
}

module.exports = { parseRef, remoteDigest, authParams, imageConfig, pickManifest };
