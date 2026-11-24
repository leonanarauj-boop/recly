// Recly — servidor de contas e turmas (Cloudflare Worker + banco D1).
// Rotas usadas pelo app: /auth/start, /auth/verify, /me, /progress, /groups...
// Configuração (painel da Cloudflare):
//   D1 database  -> binding  DB
//   Secrets      -> HOOK (senha da URL do webhook da Kiwify), RESEND_KEY (envio de e-mails, resend.com)
//   Variáveis    -> ALLOW_ORIGIN = https://recly.com.br
//                   MAIL_FROM    = Recly <nao-responda@recly.com.br>
//                   GROUP_PRODUCT_IDS = id(s) do produto "Grupo privado" na Kiwify, separados por vírgula
//                   APP_URL      = https://recly.com.br/app/
//   Cron trigger -> "0 12 * * *" (todo dia às 9h de Brasília): avisos e remoções por inatividade

const WARN_DAYS = 5, REMOVE_DAYS = 7, MAX_PRIVATE_MEMBERS = 100, TZ_OFFSET_H = -3;
const enc = new TextEncoder();
const norm = s => String(s || '').trim().toLowerCase();
const now = () => Date.now();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const rand = (n, abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789') => { const u = crypto.getRandomValues(new Uint8Array(n)); return [...u].map(x => abc[x % abc.length]).join(''); };
const brDate = (ms = now()) => new Date(ms + TZ_OFFSET_H * 3600e3).toISOString().slice(0, 10); // dia em Brasília
function weekStart(ms = now()) { const d = new Date(ms + TZ_OFFSET_H * 3600e3); const dow = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - dow); return d.toISOString().slice(0, 10); }
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s);

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };

function cors(env, extra = {}) {
  return { 'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400', ...extra };
}
const json = (env, obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: cors(env, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }) });
const one = (env, sql, ...a) => env.DB.prepare(sql).bind(...a).first();
const all = async (env, sql, ...a) => (await env.DB.prepare(sql).bind(...a).all()).results || [];
const run = (env, sql, ...a) => env.DB.prepare(sql).bind(...a).run();

// ---------- e-mail ----------
async function sendMail(env, to, subject, text) {
  if (!env.RESEND_KEY) { if (env.DEV) (env.__mails = env.__mails || []).push({ to, subject, text }); return false; }
  const html = '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:16px;line-height:1.5;color:#111">' +
    text.split('\n').map(l => l.trim() ? `<p style="margin:0 0 12px">${l.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])).replace(/(https:\/\/\S+)/g, '<a href="$1">$1</a>')}</p>` : '').join('') + '</div>';
  const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + env.RESEND_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: env.MAIL_FROM || 'Recly <nao-responda@recly.com.br>', to: [to], subject, text, html }) });
  return r.ok;
}

// ---------- limites de tentativas ----------
async function limit(env, key, max, windowSec) {
  const t = now(), row = await one(env, 'SELECT n, reset FROM rl WHERE k = ?', key);
  if (!row || row.reset < t) { await run(env, 'INSERT OR REPLACE INTO rl (k, n, reset) VALUES (?, 1, ?)', key, t + windowSec * 1000); return; }
  if (row.n >= max) fail(429, 'Muitas tentativas. Aguarde alguns minutos e tente de novo.');
  await run(env, 'UPDATE rl SET n = n + 1 WHERE k = ?', key);
}

// ---------- autenticação ----------
async function authStart(env, req, b) {
  const email = norm(b.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) fail(400, 'Digite um e-mail válido.');
  const ip = req.headers.get('CF-Connecting-IP') || 'x';
  await limit(env, 'start:' + email, 5, 3600); await limit(env, 'startip:' + ip, 20, 3600);
  const code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
  await run(env, 'INSERT OR REPLACE INTO codes (email, hash, exp, tries) VALUES (?, ?, ?, 0)', email, await sha(email + ':' + code), now() + 15 * 60e3);
  await sendMail(env, email, `${code} é o seu código do Recly`, `Seu código para entrar no Recly é: ${code}\nEle vale por 15 minutos. Se não foi você, ignore este e-mail.`);
  return env.DEV ? { ok: true, dev_code: code } : { ok: true };
}
async function authVerify(env, b) {
  const email = norm(b.email), code = String(b.code || '').replace(/\D/g, '');
  const row = await one(env, 'SELECT hash, exp, tries FROM codes WHERE email = ?', email);
  if (!row || row.exp < now()) fail(400, 'Código expirado. Peça um novo.');
  if (row.tries >= 5) fail(429, 'Muitas tentativas. Peça um novo código.');
  if (row.hash !== await sha(email + ':' + code)) { await run(env, 'UPDATE codes SET tries = tries + 1 WHERE email = ?', email); fail(400, 'Código incorreto.'); }
  await run(env, 'DELETE FROM codes WHERE email = ?', email);
  let u = await one(env, 'SELECT * FROM users WHERE email = ?', email);
  if (!u) {
    const id = rand(12, 'abcdefghijkmnpqrstuvwxyz23456789');
    await run(env, 'INSERT INTO users (id, email, nick, created, credits, last_active) VALUES (?, ?, NULL, ?, COALESCE((SELECT n FROM pending_credits WHERE email = ?), 0), NULL)', id, email, now(), email);
    await run(env, 'DELETE FROM pending_credits WHERE email = ?', email);
    u = await one(env, 'SELECT * FROM users WHERE id = ?', id);
  }
  const token = rand(40, 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
  await run(env, 'INSERT INTO sessions (hash, uid, created) VALUES (?, ?, ?)', await sha(token), u.id, now());
  return { ok: true, token, user: publicMe(u) };
}
async function auth(env, req) {
  const t = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!t) fail(401, 'Entre na sua conta.');
  const s = await one(env, 'SELECT uid FROM sessions WHERE hash = ?', await sha(t));
  const u = s && await one(env, 'SELECT * FROM users WHERE id = ?', s.uid);
  if (!u) fail(401, 'Sessão expirada. Entre de novo.');
  u.__token = t; return u;
}
const publicMe = u => ({ id: u.id, email: u.email, nick: u.nick, credits: u.credits || 0 });

// ---------- apelido ----------
const BAD = /(porra|caralh|buceta|puta|fdp|merda|viad|cuzao|arrombad|piroca|pinto|xoxota|nazi|hitler)/i;
function checkNick(n) {
  n = String(n || '').trim().replace(/\s+/g, ' ');
  if (n.length < 3 || n.length > 20) fail(400, 'O apelido deve ter de 3 a 20 caracteres.');
  if (!/^[\p{L}\p{N} _.\-]+$/u.test(n)) fail(400, 'Use só letras, números, espaço, ponto, hífen ou _.');
  if (BAD.test(n.normalize('NFD').replace(/[̀-ͯ]/g, ''))) fail(400, 'Escolha outro apelido.');
  return n;
}
async function setNick(env, u, b) {
  const nick = checkNick(b.nick);
  const taken = await one(env, 'SELECT id FROM users WHERE lower(nick) = lower(?) AND id <> ?', nick, u.id);
  if (taken) fail(409, 'Esse apelido já está em uso. Tente outro.');
  await run(env, 'UPDATE users SET nick = ? WHERE id = ?', nick, u.id);
  return { ok: true, user: publicMe({ ...u, nick }) };
}

// ---------- progresso ----------
async function postProgress(env, u, b) {
  const days = Array.isArray(b.days) ? b.days.slice(-14) : [];
  const today = brDate(), stmts = [];
  let last = null;
  for (const d of days) {
    if (!isDate(d.date) || daysBetween(d.date, today) < -1 || daysBetween(d.date, today) > 30) continue;
    const n = Math.max(0, Math.min(5000, Math.floor(+d.n || 0))), ms = Math.max(0, Math.min(24 * 3600e3, Math.floor(+d.ms || 0)));
    stmts.push(env.DB.prepare('INSERT INTO progress (uid, date, n, ms) VALUES (?, ?, ?, ?) ON CONFLICT(uid, date) DO UPDATE SET n = MAX(n, excluded.n), ms = MAX(ms, excluded.ms)').bind(u.id, d.date, n, ms));
    if (n > 0 && (!last || d.date > last)) last = d.date;
  }
  const streak = Math.max(0, Math.min(5000, Math.floor(+b.streak || 0)));
  stmts.push(env.DB.prepare('UPDATE users SET streak = ? WHERE id = ?').bind(streak, u.id));
  if (last) {
    stmts.push(env.DB.prepare('UPDATE users SET last_active = MAX(COALESCE(last_active, ?), ?) WHERE id = ?').bind(last, last, u.id));
    stmts.push(env.DB.prepare('UPDATE members SET warned = 0 WHERE uid = ?').bind(u.id));
  }
  await env.DB.batch(stmts);
  return { ok: true };
}

// ---------- turmas ----------
const groupOut = (g, extra = {}) => ({ id: g.id, name: g.name, desc: g.desc || '', emoji: g.emoji || '📚', private: !!g.private, goal: g.goal, owner: g.owner === extra.uid, members: g.members ?? undefined, ...extra, uid: undefined });
function inactivity(m, u, today = brDate()) {
  const ref = u.last_active && u.last_active >= brDate(m.joined) ? u.last_active : brDate(m.joined);
  return daysBetween(ref, today);
}
async function listGroups(env, u) {
  const mine = await all(env, 'SELECT g.*, m.joined, (SELECT COUNT(*) FROM members x WHERE x.gid = g.id) AS members FROM groups g JOIN members m ON m.gid = g.id AND m.uid = ? ORDER BY g.private, g.name', u.id);
  const pub = await all(env, 'SELECT g.*, (SELECT COUNT(*) FROM members x WHERE x.gid = g.id) AS members FROM groups g WHERE g.private = 0 AND g.id NOT IN (SELECT gid FROM members WHERE uid = ?) ORDER BY g.name', u.id);
  const removed = await all(env, 'SELECT g.id, g.name, r.at FROM removals r JOIN groups g ON g.id = r.gid WHERE r.uid = ? AND r.seen = 0', u.id);
  if (removed.length) await run(env, 'UPDATE removals SET seen = 1 WHERE uid = ?', u.id);
  return {
    mine: mine.map(g => { const days = inactivity(g, u); return groupOut(g, { uid: u.id, inactiveDays: days, warn: g.owner !== u.id && days >= WARN_DAYS }); }),
    open: pub.map(g => groupOut(g, { uid: u.id })), removed: removed.map(r => ({ id: r.id, name: r.name })), me: publicMe(u),
  };
}
async function groupDetail(env, u, gid) {
  const g = await one(env, 'SELECT * FROM groups WHERE id = ?', gid); if (!g) fail(404, 'Turma não encontrada.');
  const mem = await one(env, 'SELECT * FROM members WHERE gid = ? AND uid = ?', gid, u.id);
  if (!mem && g.private) fail(403, 'Esta turma é privada.');
  const ws = weekStart(), rows = await all(env, `SELECT u.id, u.nick, u.streak, u.last_active, m.joined, COALESCE((SELECT SUM(p.n) FROM progress p WHERE p.uid = u.id AND p.date >= ?), 0) AS week,
      COALESCE((SELECT SUM(p.ms) FROM progress p WHERE p.uid = u.id AND p.date >= ?), 0) AS wms, COALESCE((SELECT n FROM progress p WHERE p.uid = u.id AND p.date = ?), 0) AS today
      FROM members m JOIN users u ON u.id = m.uid WHERE m.gid = ? ORDER BY week DESC, u.streak DESC, m.joined ASC LIMIT 500`, ws, ws, brDate(), gid);
  const total = rows.reduce((a, r) => a + r.week, 0);
  return {
    group: { ...groupOut({ ...g, members: rows.length }, { uid: u.id }), code: g.owner === u.id ? g.code : undefined, member: !!mem },
    week: { start: ws, total, goal: g.goal, pct: g.goal ? Math.min(100, Math.round(total * 100 / g.goal)) : null },
    ranking: rows.map((r, i) => ({ pos: i + 1, nick: r.nick || 'Sem apelido', week: r.week, minutes: Math.round(r.wms / 60000), today: r.today, streak: r.streak || 0, me: r.id === u.id, owner: r.id === g.owner, id: g.owner === u.id ? r.id : undefined })),
    me: mem ? { inactiveDays: inactivity(mem, u), warn: g.owner !== u.id && inactivity(mem, u) >= WARN_DAYS, removeIn: Math.max(0, REMOVE_DAYS - inactivity(mem, u)) } : null,
  };
}
async function joinGroup(env, u, gid, b) {
  if (!u.nick) fail(400, 'Escolha um apelido antes de entrar numa turma.');
  let g = gid ? await one(env, 'SELECT * FROM groups WHERE id = ?', gid) : await one(env, 'SELECT * FROM groups WHERE code = ?', String(b.code || '').trim().toUpperCase());
  if (!g) fail(404, gid ? 'Turma não encontrada.' : 'Código de convite inválido.');
  if (g.private && String(b.code || '').trim().toUpperCase() !== g.code) fail(403, 'Esta turma é privada: use o link de convite.');
  if (g.private) { const c = await one(env, 'SELECT COUNT(*) AS n FROM members WHERE gid = ?', g.id); if (c.n >= MAX_PRIVATE_MEMBERS) fail(403, 'Esta turma está cheia.'); }
  await run(env, 'INSERT OR IGNORE INTO members (gid, uid, joined, warned) VALUES (?, ?, ?, 0)', g.id, u.id, now());
  return { ok: true, id: g.id, name: g.name };
}
async function leaveGroup(env, u, gid) {
  const g = await one(env, 'SELECT * FROM groups WHERE id = ?', gid); if (!g) fail(404, 'Turma não encontrada.');
  if (g.owner === u.id) fail(400, 'Você é o dono desta turma. Para sair, exclua a turma.');
  await run(env, 'DELETE FROM members WHERE gid = ? AND uid = ?', gid, u.id); return { ok: true };
}
async function createGroup(env, u, b) {
  if (!u.nick) fail(400, 'Escolha um apelido antes de criar uma turma.');
  if ((u.credits || 0) < 1) fail(402, 'Para criar uma turma privada, compre o crédito na Loja.');
  const name = String(b.name || '').trim().replace(/\s+/g, ' ');
  if (name.length < 3 || name.length > 40) fail(400, 'O nome deve ter de 3 a 40 caracteres.');
  if (BAD.test(name.normalize('NFD').replace(/[̀-ͯ]/g, ''))) fail(400, 'Escolha outro nome.');
  const goal = Math.max(0, Math.min(1e6, Math.floor(+b.goal || 0))) || null, id = 'p' + rand(9, 'abcdefghijkmnpqrstuvwxyz23456789'), code = rand(8);
  const r = await run(env, 'UPDATE users SET credits = credits - 1 WHERE id = ? AND credits >= 1', u.id);
  if (r.meta && r.meta.changes === 0) fail(402, 'Crédito indisponível.');
  await env.DB.batch([
    env.DB.prepare('INSERT INTO groups (id, name, "desc", emoji, private, goal, owner, code, created) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)').bind(id, name, String(b.desc || '').slice(0, 140), String(b.emoji || '🔒').slice(0, 4), goal, u.id, code, now()),
    env.DB.prepare('INSERT INTO members (gid, uid, joined, warned) VALUES (?, ?, ?, 0)').bind(id, u.id, now()),
  ]);
  return { ok: true, id, code };
}
async function ownerOnly(env, u, gid) { const g = await one(env, 'SELECT * FROM groups WHERE id = ?', gid); if (!g || g.owner !== u.id) fail(403, 'Só o dono da turma pode fazer isso.'); return g; }
async function kick(env, u, gid, b) {
  const g = await ownerOnly(env, u, gid); if (b.uid === u.id) fail(400, 'Você não pode remover a si mesmo.');
  await run(env, 'DELETE FROM members WHERE gid = ? AND uid = ?', g.id, String(b.uid || '')); return { ok: true };
}
async function updateGroup(env, u, gid, b) {
  const g = await ownerOnly(env, u, gid);
  const name = b.name != null ? String(b.name).trim().replace(/\s+/g, ' ') : g.name;
  if (name.length < 3 || name.length > 40) fail(400, 'O nome deve ter de 3 a 40 caracteres.');
  const goal = b.goal != null ? (Math.max(0, Math.min(1e6, Math.floor(+b.goal || 0))) || null) : g.goal;
  const code = b.newCode ? rand(8) : g.code;
  await run(env, 'UPDATE groups SET name = ?, goal = ?, code = ? WHERE id = ?', name, goal, code, g.id); return { ok: true, code };
}
async function deleteGroup(env, u, gid) {
  const g = await ownerOnly(env, u, gid);
  await env.DB.batch([env.DB.prepare('DELETE FROM members WHERE gid = ?').bind(g.id), env.DB.prepare('DELETE FROM removals WHERE gid = ?').bind(g.id), env.DB.prepare('DELETE FROM groups WHERE id = ?').bind(g.id)]);
  return { ok: true };
}
async function deleteMe(env, u) {
  const owned = await all(env, 'SELECT id FROM groups WHERE owner = ?', u.id);
  const st = [];
  for (const g of owned) st.push(env.DB.prepare('DELETE FROM members WHERE gid = ?').bind(g.id), env.DB.prepare('DELETE FROM removals WHERE gid = ?').bind(g.id), env.DB.prepare('DELETE FROM groups WHERE id = ?').bind(g.id));
  for (const t of ['members', 'progress', 'removals', 'sessions']) st.push(env.DB.prepare(`DELETE FROM ${t} WHERE uid = ?`).bind(u.id));
  st.push(env.DB.prepare('DELETE FROM users WHERE id = ?').bind(u.id));
  await env.DB.batch(st); return { ok: true };
}

// ---------- inatividade (roda pelo Cron) ----------
async function sweep(env) {
  const today = brDate(), app = env.APP_URL || 'https://recly.com.br/app/';
  const rows = await all(env, 'SELECT m.gid, m.uid, m.joined, m.warned, u.email, u.last_active, u.nick, g.name, g.owner FROM members m JOIN users u ON u.id = m.uid JOIN groups g ON g.id = m.gid');
  const out = { warned: 0, removed: 0 };
  const byUser = new Map();
  for (const r of rows) {
    if (r.owner === r.uid) continue;
    const days = inactivity(r, r, today);
    if (days >= REMOVE_DAYS) {
      await run(env, 'DELETE FROM members WHERE gid = ? AND uid = ?', r.gid, r.uid);
      await run(env, 'INSERT INTO removals (gid, uid, at, seen) VALUES (?, ?, ?, 0)', r.gid, r.uid, now());
      out.removed++; (byUser.get(r.uid) || byUser.set(r.uid, { email: r.email, warn: [], removed: [] }).get(r.uid)).removed.push(r.name);
    } else if (days >= WARN_DAYS && !r.warned) {
      await run(env, 'UPDATE members SET warned = 1 WHERE gid = ? AND uid = ?', r.gid, r.uid);
      out.warned++; (byUser.get(r.uid) || byUser.set(r.uid, { email: r.email, warn: [], removed: [] }).get(r.uid)).warn.push(r.name);
    }
  }
  for (const [, x] of byUser) {
    if (x.removed.length) await sendMail(env, x.email, 'Você saiu da sua turma no Recly', `Como você ficou ${REMOVE_DAYS} dias sem estudar, saiu de: ${x.removed.join(', ')}.\nSem problema: é só abrir o Recly, estudar e entrar de novo na turma com um toque.\n${app}`);
    else if (x.warn.length) await sendMail(env, x.email, 'Sua turma sente sua falta 📚', `Faz ${WARN_DAYS} dias que você não estuda no Recly. Se completar ${REMOVE_DAYS} dias, você sai de: ${x.warn.join(', ')}.\nEstude alguns cartões hoje para continuar no ranking.\n${app}`);
  }
  await run(env, 'DELETE FROM sessions WHERE created < ?', now() - 180 * 864e5);
  await run(env, 'DELETE FROM rl WHERE reset < ?', now());
  await run(env, 'DELETE FROM progress WHERE date < ?', brDate(now() - 120 * 864e5));
  return out;
}

// ---------- Kiwify: compra do "Grupo privado" ----------
function parseKiwify(p) {
  const ev = norm(p.webhook_event_type || p.event || p.trigger), st = norm(p.order_status);
  const revoked = /reembols|refund|chargeback/.test(ev) || /refund|chargeback|reembols/.test(st);
  const approved = !revoked && (/aprovad|approved|paid/.test(ev) || st === 'paid' || st === 'approved');
  const prod = p.Product || p.product || {};
  return { approved, revoked, pid: String(prod.product_id || prod.id || p.product_id || '').trim(), email: norm((p.Customer || p.customer || {}).email || p.email), order: String(p.order_id || p.id || p.order_ref || '').trim() };
}
async function webhook(env, req, url) {
  if (!env.HOOK || url.searchParams.get('k') !== env.HOOK) fail(403, 'forbidden');
  let p; try { p = await req.json(); } catch (e) { fail(400, 'json'); }
  const o = parseKiwify(p), allowed = String(env.GROUP_PRODUCT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  await run(env, 'INSERT INTO hooklog (at, ev, pid, email, approved, revoked) VALUES (?, ?, ?, ?, ?, ?)', now(), String(p.webhook_event_type || p.order_status || ''), o.pid, o.email.replace(/^(.).*(@.*)$/, '$1***$2'), o.approved ? 1 : 0, o.revoked ? 1 : 0);
  if (!o.email || !o.order || (allowed.length && !allowed.includes(o.pid))) return { ok: true, ignored: true };
  const seen = await one(env, 'SELECT status FROM orders WHERE id = ?', o.order);
  const delta = o.approved && (!seen || seen.status !== 'ok') ? 1 : o.revoked && seen && seen.status === 'ok' ? -1 : 0;
  if (!delta) return { ok: true, ignored: true };
  await run(env, 'INSERT OR REPLACE INTO orders (id, email, status, at) VALUES (?, ?, ?, ?)', o.order, o.email, delta > 0 ? 'ok' : 'revoked', now());
  const u = await one(env, 'SELECT id FROM users WHERE email = ?', o.email);
  if (u) await run(env, 'UPDATE users SET credits = MAX(0, credits + ?) WHERE id = ?', delta, u.id);
  else await run(env, 'INSERT INTO pending_credits (email, n) VALUES (?, MAX(0, ?)) ON CONFLICT(email) DO UPDATE SET n = MAX(0, n + ?)', o.email, delta, delta);
  if (delta > 0) await sendMail(env, o.email, 'Seu crédito para criar uma turma no Recly', `Obrigado pela compra! Abra o Recly, vá em Turmas, entre com este e-mail (${o.email}) e toque em "Criar turma privada".\n${env.APP_URL || 'https://recly.com.br/app/'}`);
  return { ok: true, credit: delta };
}

// ---------- roteador ----------
export default {
  async fetch(req, env) {
    const url = new URL(req.url), p = url.pathname.replace(/\/+$/, '') || '/', M = req.method;
    if (M === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });
    try {
      const body = async () => { try { return await req.json(); } catch (e) { return {}; } };
      if (p === '/' && M === 'GET') return json(env, { ok: true, service: 'recly-turmas' });
      if (p === '/auth/start' && M === 'POST') return json(env, await authStart(env, req, await body()));
      if (p === '/auth/verify' && M === 'POST') return json(env, await authVerify(env, await body()));
      if (p === '/webhook' && M === 'POST') return json(env, await webhook(env, req, url));
      if (p === '/log' && M === 'GET') { if (!env.HOOK || url.searchParams.get('k') !== env.HOOK) fail(403, 'forbidden'); return json(env, { events: await all(env, 'SELECT * FROM hooklog ORDER BY at DESC LIMIT 30') }); }
      const u = await auth(env, req);
      if (p === '/me' && M === 'GET') return json(env, await listGroups(env, u));
      if (p === '/me' && M === 'POST') return json(env, await setNick(env, u, await body()));
      if (p === '/me' && M === 'DELETE') return json(env, await deleteMe(env, u));
      if (p === '/logout' && M === 'POST') { await run(env, 'DELETE FROM sessions WHERE hash = ?', await sha(u.__token)); return json(env, { ok: true }); }
      if (p === '/progress' && M === 'POST') return json(env, await postProgress(env, u, await body()));
      if (p === '/groups' && M === 'POST') return json(env, await createGroup(env, u, await body()));
      if (p === '/join' && M === 'POST') return json(env, await joinGroup(env, u, null, await body()));
      const m = /^\/groups\/([\w-]{1,20})(?:\/(join|leave|kick|update))?$/.exec(p);
      if (m) {
        const [, gid, act] = m;
        if (!act && M === 'GET') return json(env, await groupDetail(env, u, gid));
        if (!act && M === 'DELETE') return json(env, await deleteGroup(env, u, gid));
        if (act === 'join' && M === 'POST') return json(env, await joinGroup(env, u, gid, await body()));
        if (act === 'leave' && M === 'POST') return json(env, await leaveGroup(env, u, gid));
        if (act === 'kick' && M === 'POST') return json(env, await kick(env, u, gid, await body()));
        if (act === 'update' && M === 'POST') return json(env, await updateGroup(env, u, gid, await body()));
      }
      fail(404, 'not found');
    } catch (e) {
      if (e instanceof HttpError) return json(env, { error: e.message }, e.status);
      console.log(e && e.stack); return json(env, { error: 'Erro no servidor. Tente de novo.' }, 500);
    }
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(sweep(env)); },
  _sweep: sweep, // testes
};
