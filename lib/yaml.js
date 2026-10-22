'use strict';
/* Kleine YAML-schrijver. Strings schrijven we als JSON (JSON is geldige YAML), dus aanhalingstekens,
 * dubbele punten en regeleinden zijn nooit een probleem. Lege lijsten/objecten en null blijven behouden. */
const yKey = (k) => (/^[A-Za-z0-9_.\-/]+$/.test(k) ? k : JSON.stringify(k));
function scalar(x) {
  if (x === null || x === undefined) return 'null';
  if (typeof x === 'number' || typeof x === 'boolean') return String(x);
  if (Array.isArray(x)) return '[]';
  if (typeof x === 'object') return '{}';
  return JSON.stringify(String(x));
}
const isEmpty = (x) => x === null || typeof x !== 'object' || (Array.isArray(x) ? !x.length : !Object.keys(x).length);

function toYaml(v, indent = 0) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(v)) {
    return v.map((x) => (isEmpty(x) ? pad + '- ' + scalar(x) : pad + '- ' + toYaml(x, indent + 2).trimStart())).join('\n');
  }
  return Object.entries(v).filter(([, x]) => x !== undefined)
    .map(([k, x]) => (isEmpty(x) ? pad + yKey(k) + ': ' + scalar(x) : pad + yKey(k) + ':\n' + toYaml(x, indent + 2))).join('\n');
}

module.exports = { toYaml };
