'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('why an app stopped right after starting', () => {
  const { startError } = require('../lib/docker');
  assert.equal(startError(['Starting…', '\x1b[31mError: EACCES: permission denied, open \'/config/app.db\'\x1b[0m', 'exiting'], ''),
    'Error: EACCES: permission denied, open \'/config/app.db\'');
  assert.equal(startError(['booting', 'bye'], ''), 'bye');
  assert.equal(startError(['x'], 'error mounting "/tank/media": no such file or directory'), 'error mounting "/tank/media": no such file or directory');
  assert.equal(startError([], ''), '');
});
