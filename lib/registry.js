'use strict';
/*
 * Nieuwste digest van een image-tag opvragen bij de registry (Docker Hub, ghcr.io, lscr.io, quay.io …).
 * Met een HEAD-verzoek: er wordt niets gedownload en Docker Hub telt het niet mee voor de limiet.
 * Aanmelden gaat anoniem via het token dat de registry zelf aanwijst (WWW-Authenticate).
 */
const crypto = require('node:crypto');

const ACCEPT = [
  'application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json', 'application/vnd.oci.image.manifest.v1+json',
].join(', ');

// "jellyfin/jellyfin:latest" → { registry: 'registry-1.docker.io', repo: 'jellyfin/jellyfin', tag: 'latest' }
function parseRef(ref) {
  let name = String(ref || '').trim();
  if (!name || name.includes('@') || name.startsWith('sha256:')) return null; // vast op een digest: geen updates
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

// Een verzoek aan de registry, met het anonieme token als de registry erom vraagt (één keer per repository).
function client(r, timeout) {
  const headers = {};
  return async function req(path, { method = 'GET', accept = ACCEPT } = {}) {
    const url = `https://${r.registry}/v2/${r.repo}/${path}`;
    const go = () => fetch(url, { method, headers: { ...headers, Accept: accept }, redirect: 'follow', signal: AbortSignal.timeout(timeout) });
    let res = await go();
    if (res.status === 401 && !headers.Authorization) {
      const p = authParams(res.headers.get('www-authenticate'));
      if (!p.realm) throw new Error('de registry vraagt een aanmelding');
      const u = new URL(p.realm);
      if (p.service) u.searchParams.set('service', p.service);
      u.searchParams.set('scope', p.scope || `repository:${r.repo}:pull`);
      const t = await fetch(u, { signal: AbortSignal.timeout(timeout) });
      if (!t.ok) throw new Error(t.status === 401 || t.status === 403 ? 'privé-image, aanmelden is niet ingesteld' : 'aanmelden bij de registry lukte niet (' + t.status + ')');
      const j = await t.json();
      headers.Authorization = 'Bearer ' + (j.token || j.access_token);
      res = await go();
    }
    if (res.status === 404) throw new Error('deze tag bestaat niet (meer) in de registry');
    if (res.status === 401 || res.status === 403) throw new Error('privé-image, aanmelden is niet ingesteld');
    if (res.status === 429) throw new Error('de registry vraagt om even te wachten (te veel verzoeken)');
    if (!res.ok) throw new Error('de registry gaf fout ' + res.status);
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
  // Enkele registries geven bij HEAD geen digest: dan het manifest ophalen en zelf hashen.
  const body = Buffer.from(await (await req(path)).arrayBuffer());
  return 'sha256:' + crypto.createHash('sha256').update(body).digest('hex');
}

// Uit een lijst met manifests (multi-arch) het juiste voor deze server kiezen.
function pickManifest(index, arch) {
  const list = (index && index.manifests) || [];
  const linux = list.filter((m) => m.platform && m.platform.os === 'linux');
  return linux.find((m) => m.platform.architecture === arch) || null;
}

// Wat het image zelf meldt: poorten (EXPOSE), mappen (VOLUME), variabelen, labels. Zonder het image te downloaden.
async function imageConfig(ref, { arch = 'amd64', timeout = 20000 } = {}) {
  const r = parseRef(ref);
  if (!r) throw new Error('dit is geen geldige image-naam');
  const req = client(r, timeout);
  let man = await (await req('manifests/' + encodeURIComponent(r.tag))).json();
  if (man.manifests) {
    const m = pickManifest(man, arch);
    if (!m) throw new Error(`dit image bestaat niet voor deze server (${arch})`);
    man = await (await req('manifests/' + m.digest)).json();
  }
  if (!man.config || !man.config.digest) throw new Error('het manifest van dit image heeft geen configuratie');
  const cfg = await (await req('blobs/' + man.config.digest, { accept: '*/*' })).json();
  return { ref: r, config: cfg.config || {} };
}

module.exports = { parseRef, remoteDigest, authParams, imageConfig, pickManifest };
