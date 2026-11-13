'use strict';
/* Saved AI chats, per account, in DATA_DIR/chats/<account>.json (0600).
 * A chat: {id, title, model, created, updated, messages: [{role: user|assistant, content, thinking, secs, tools, error, stopped, at}]}.
 * The model gets the user and assistant texts of the chat as its context (lib/ai.js). */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { httpError } = require('./system');

const MAX_CHATS = 300;
const MAX_MESSAGES = 500;
const MAX_TEXT = 20000;
const ID = /^[a-f0-9]{12}$/;

function dataDir() { return process.env.DATA_DIR || '/var/lib/majaos'; }
// The owner (no name in older sessions) is "_owner"; other names are already lowercase [a-z0-9._-].
function fileFor(account) {
  const name = String(account || '_owner').toLowerCase().replace(/[^a-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 40) || '_owner';
  return path.join(dataDir(), 'chats', name + '.json');
}
function readAll(account) {
  try {
    const data = JSON.parse(fs.readFileSync(fileFor(account), 'utf8'));
    return Array.isArray(data.chats) ? data.chats : [];
  } catch { return []; }
}
function writeAll(account, chats) {
  const dest = fileFor(account);
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  fs.writeFileSync(dest + '.tmp', JSON.stringify({ chats }), { mode: 0o600 });
  fs.renameSync(dest + '.tmp', dest);
}

const brief = (c) => ({ id: c.id, title: c.title, model: c.model, created: c.created, updated: c.updated, count: c.messages.length });
function list(account) {
  return readAll(account).map(brief).sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
}
function find(chats, id) {
  if (!ID.test(String(id || ''))) throw httpError('That chat does not exist (anymore).', 404);
  const c = chats.find((x) => x.id === id);
  if (!c) throw httpError('That chat does not exist (anymore).', 404);
  return c;
}
function get(account, id) { return find(readAll(account), id); }

const cleanTitle = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 80);
const cleanModel = (s) => String(s || '').trim().slice(0, 200);

function create(account, body = {}) {
  const chats = readAll(account);
  const now = new Date().toISOString();
  const chat = { id: crypto.randomBytes(6).toString('hex'), title: cleanTitle(body.title), model: cleanModel(body.model), created: now, updated: now, messages: [] };
  chats.push(chat);
  // The oldest chats go when there are too many.
  chats.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  writeAll(account, chats.slice(0, MAX_CHATS));
  return chat;
}

function update(account, id, body = {}) {
  const chats = readAll(account);
  const c = find(chats, id);
  if (body.title !== undefined) {
    const title = cleanTitle(body.title);
    if (!title) throw httpError('Type a name for the chat.', 400);
    c.title = title;
  }
  if (body.model !== undefined) c.model = cleanModel(body.model);
  writeAll(account, chats);
  return brief(c);
}

function remove(account, id) {
  const chats = readAll(account);
  find(chats, id);
  writeAll(account, chats.filter((x) => x.id !== id));
  return { removed: id };
}

// A title from the first question: its first line, cut at a word.
function titleFrom(text) {
  const line = String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  if (line.length <= 60) return line;
  const cut = line.slice(0, 60);
  return (cut.lastIndexOf(' ') > 30 ? cut.slice(0, cut.lastIndexOf(' ')) : cut) + '…';
}

function cleanMessage(m) {
  const out = { role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, MAX_TEXT), at: new Date().toISOString() };
  if (m.thinking) out.thinking = String(m.thinking).slice(0, MAX_TEXT);
  if (m.secs) out.secs = Math.max(1, Math.round(Number(m.secs) || 0));
  if (Array.isArray(m.tools) && m.tools.length) out.tools = m.tools.slice(0, 20).map(String);
  if (m.error) out.error = String(m.error).slice(0, 1000);
  if (m.stopped) out.stopped = true;
  return out;
}

function append(account, id, messages, { model } = {}) {
  const chats = readAll(account);
  const c = find(chats, id);
  for (const m of messages) c.messages.push(cleanMessage(m));
  c.messages = c.messages.slice(-MAX_MESSAGES);
  if (!c.title) { const q = c.messages.find((m) => m.role === 'user'); if (q) c.title = titleFrom(q.content); }
  if (model) c.model = cleanModel(model);
  c.updated = new Date().toISOString();
  writeAll(account, chats);
  return c;
}

// What the model sees: the questions and answers, without failed or empty turns.
// A question whose answer failed is left out too, so it isn't asked twice when the user tries again.
function context(chat) {
  const list = chat.messages;
  return list.filter((m, i) => (m.role === 'user' ? !(list[i + 1] && list[i + 1].error) : m.content && !m.error))
    .map((m) => ({ role: m.role, content: m.content }));
}

module.exports = { list, get, create, update, remove, append, context, titleFrom, fileFor };
