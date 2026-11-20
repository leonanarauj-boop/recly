// Leitor e gravador mínimos de arquivos SQLite 3 (tabelas com rowid, UTF-8).
// Suficiente para ler/gerar o banco interno de um .apkg do Anki.
const SQLite = (() => {
  const td = new TextDecoder('utf-8');
  const te = new TextEncoder();
  const EMPTY = new Uint8Array(0);

  function varint(b, p) {
    let v = 0;
    for (let i = 0; i < 8; i++) {
      const c = b[p + i];
      v = v * 128 + (c & 0x7f);
      if (!(c & 0x80)) return [v, p + i + 1];
    }
    return [v * 256 + b[p + 8], p + 9];
  }

  function readInt(dv, q, sz) {
    if (sz === 8) return Number(dv.getBigInt64(q));
    let v = 0;
    for (let i = 0; i < sz; i++) v = v * 256 + dv.getUint8(q + i);
    const lim = 2 ** (sz * 8 - 1);
    return v >= lim ? v - 2 * lim : v;
  }

  function parseCols(sql) {
    sql = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' '); // ignora comentários (/* 0 */ etc.)
    const s = sql.slice(sql.indexOf('(') + 1, sql.lastIndexOf(')'));
    const parts = [];
    let depth = 0, cur = '';
    for (const ch of s) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
    }
    parts.push(cur);
    const cols = [];
    for (const p of parts) {
      const t = p.trim();
      if (/^(primary|unique|foreign|check|constraint)\b/i.test(t)) continue;
      const m = t.match(/^["`\[]?(\w+)["`\]]?\s*([\s\S]*)$/);
      if (m) cols.push({ name: m[1], pk: /integer\s+primary\s+key/i.test(m[2]) });
    }
    return cols;
  }

  class Reader {
    constructor(buf) {
      this.b = buf;
      this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      if (buf.length < 100 || td.decode(buf.subarray(0, 15)) !== 'SQLite format 3') throw new Error('Arquivo não é um banco SQLite válido');
      const ps = this.dv.getUint16(16);
      this.ps = ps === 1 ? 65536 : ps;
      this.U = this.ps - buf[20];
      if (this.dv.getUint32(56) > 1) throw new Error('Codificação UTF-16 não suportada');
      this.tables = {};
      for (const r of this.scan(1)) {
        if (r.v[0] === 'table') this.tables[r.v[1]] = { root: r.v[3], sql: r.v[4], cols: parseCols(r.v[4]) };
      }
    }

    * scan(pageNo) {
      const off = (pageNo - 1) * this.ps;
      const hdr = off + (pageNo === 1 ? 100 : 0);
      const type = this.b[hdr];
      const n = this.dv.getUint16(hdr + 3);
      if (type === 0x0d) {
        for (let i = 0; i < n; i++) {
          const p = off + this.dv.getUint16(hdr + 8 + i * 2);
          const [plen, p2] = varint(this.b, p);
          const [rowid, p3] = varint(this.b, p2);
          yield { rowid, v: this.record(this.payload(p3, plen)) };
        }
      } else if (type === 0x05) {
        for (let i = 0; i < n; i++) {
          const p = off + this.dv.getUint16(hdr + 12 + i * 2);
          yield* this.scan(this.dv.getUint32(p));
        }
        yield* this.scan(this.dv.getUint32(hdr + 8));
      } else {
        throw new Error('Página SQLite inesperada (tipo ' + type + ')');
      }
    }

    payload(p, plen) {
      const U = this.U, X = U - 35;
      if (plen <= X) return this.b.subarray(p, p + plen);
      const M = Math.floor((U - 12) * 32 / 255) - 23;
      const K = M + ((plen - M) % (U - 4));
      const local = K <= X ? K : M;
      const out = new Uint8Array(plen);
      out.set(this.b.subarray(p, p + local), 0);
      let got = local, next = this.dv.getUint32(p + local);
      while (got < plen && next) {
        const po = (next - 1) * this.ps;
        const take = Math.min(U - 4, plen - got);
        out.set(this.b.subarray(po + 4, po + 4 + take), got);
        got += take;
        next = this.dv.getUint32(po);
      }
      return out;
    }

    record(pl) {
      const dv = new DataView(pl.buffer, pl.byteOffset, pl.byteLength);
      let [hlen, p] = varint(pl, 0);
      const types = [];
      while (p < hlen) { const [t, np] = varint(pl, p); types.push(t); p = np; }
      let q = hlen;
      const out = [];
      for (const t of types) {
        if (t === 0) out.push(null);
        else if (t === 8) out.push(0);
        else if (t === 9) out.push(1);
        else if (t >= 1 && t <= 6) { const sz = [0, 1, 2, 3, 4, 6, 8][t]; out.push(readInt(dv, q, sz)); q += sz; }
        else if (t === 7) { out.push(dv.getFloat64(q)); q += 8; }
        else if (t >= 12) {
          const len = t % 2 === 0 ? (t - 12) / 2 : (t - 13) / 2;
          const bytes = pl.subarray(q, q + len);
          out.push(t % 2 === 0 ? bytes.slice() : td.decode(bytes));
          q += len;
        } else throw new Error('Tipo de coluna inválido');
      }
      return out;
    }

    /** Todas as linhas de uma tabela como objetos {coluna: valor}. */
    rows(name) {
      const t = this.tables[name];
      if (!t) return [];
      const out = [];
      for (const r of this.scan(t.root)) {
        const o = {};
        t.cols.forEach((c, i) => { o[c.name] = c.pk ? r.rowid : (r.v[i] === undefined ? null : r.v[i]); });
        out.push(o);
      }
      return out;
    }
  }

  // ---------- Gravador ----------
  function varintBytes(v) {
    if (v < 128) return [v];
    const out = [];
    while (v > 0) { out.unshift(v % 128); v = Math.floor(v / 128); }
    for (let i = 0; i < out.length - 1; i++) out[i] |= 0x80;
    return out;
  }

  function intBytes(v, sz) {
    if (sz === 8) {
      let b = BigInt.asUintN(64, BigInt(v));
      const out = new Array(8);
      for (let i = 7; i >= 0; i--) { out[i] = Number(b & 0xffn); b >>= 8n; }
      return out;
    }
    if (v < 0) v += 2 ** (sz * 8);
    const out = new Array(sz);
    for (let i = sz - 1; i >= 0; i--) { out[i] = v % 256; v = Math.floor(v / 256); }
    return out;
  }

  function encodeRecord(vals) {
    const types = [], bodies = [];
    for (let v of vals) {
      if (typeof v === 'boolean') v = v ? 1 : 0;
      if (v === null || v === undefined) { types.push(0); bodies.push(EMPTY); }
      else if (typeof v === 'number' && Number.isInteger(v)) {
        if (v === 0) { types.push(8); bodies.push(EMPTY); }
        else if (v === 1) { types.push(9); bodies.push(EMPTY); }
        else {
          let t, sz;
          if (v >= -128 && v <= 127) { t = 1; sz = 1; }
          else if (v >= -32768 && v <= 32767) { t = 2; sz = 2; }
          else if (v >= -8388608 && v <= 8388607) { t = 3; sz = 3; }
          else if (v >= -2147483648 && v <= 2147483647) { t = 4; sz = 4; }
          else if (Math.abs(v) < 2 ** 47) { t = 5; sz = 6; }
          else { t = 6; sz = 8; }
          types.push(t); bodies.push(Uint8Array.from(intBytes(v, sz)));
        }
      } else if (typeof v === 'number') {
        const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v);
        types.push(7); bodies.push(b);
      } else if (typeof v === 'string') {
        const b = te.encode(v); types.push(13 + 2 * b.length); bodies.push(b);
      } else if (v instanceof Uint8Array) {
        types.push(12 + 2 * v.length); bodies.push(v);
      } else throw new Error('Valor não suportado: ' + typeof v);
    }
    const tb = [];
    for (const t of types) tb.push(...varintBytes(t));
    let hlen = tb.length + 1;
    let hv = varintBytes(hlen);
    if (hv.length > 1) { hlen = tb.length + hv.length; hv = varintBytes(hlen); }
    let total = hlen;
    for (const b of bodies) total += b.length;
    const out = new Uint8Array(total);
    out.set(hv, 0); out.set(tb, hv.length);
    let q = hlen;
    for (const b of bodies) { out.set(b, q); q += b.length; }
    return out;
  }

  class Writer {
    constructor(pageSize = 4096) {
      this.ps = pageSize;
      this.pages = [null, null]; // índice 0 não usado; página 1 reservada
      this.master = [];
    }

    _alloc() { this.pages.push(null); return this.pages.length - 1; }

    _cell(rowid, payload) {
      const U = this.ps, X = U - 35, M = Math.floor((U - 12) * 32 / 255) - 23;
      const plen = payload.length;
      let local = plen, first = 0;
      if (plen > X) {
        const K = M + ((plen - M) % (U - 4));
        local = K <= X ? K : M;
        const nums = [];
        for (let pos = local; pos < plen; pos += U - 4) nums.push(this._alloc());
        nums.forEach((no, i) => {
          const pos = local + i * (U - 4);
          const pg = new Uint8Array(this.ps);
          new DataView(pg.buffer).setUint32(0, nums[i + 1] || 0);
          pg.set(payload.subarray(pos, Math.min(pos + U - 4, plen)), 4);
          this.pages[no] = pg;
        });
        first = nums[0];
      }
      const head = [...varintBytes(plen), ...varintBytes(rowid)];
      const cell = new Uint8Array(head.length + local + (first ? 4 : 0));
      cell.set(head, 0);
      cell.set(payload.subarray(0, local), head.length);
      if (first) new DataView(cell.buffer).setUint32(head.length + local, first);
      return cell;
    }

    _page(type, cells, hdrOff, right) {
      const pg = new Uint8Array(this.ps);
      const dv = new DataView(pg.buffer);
      const hsize = type === 0x05 ? 12 : 8;
      let content = this.ps;
      cells.forEach((c, i) => {
        content -= c.length;
        pg.set(c, content);
        dv.setUint16(hdrOff + hsize + i * 2, content);
      });
      pg[hdrOff] = type;
      dv.setUint16(hdrOff + 3, cells.length);
      dv.setUint16(hdrOff + 5, content === 65536 ? 0 : content);
      if (type === 0x05) dv.setUint32(hdrOff + 8, right);
      return pg;
    }

    _buildTree(rows) {
      // rows: [[rowid, [valores...]]] já ordenadas por rowid
      const cap = this.ps - 8;
      let leaves = [], cur = [], used = 0, maxId = 0;
      const flush = () => {
        const no = this._alloc();
        this.pages[no] = this._page(0x0d, cur, 0);
        leaves.push({ page: no, key: maxId });
        cur = []; used = 0;
      };
      for (const [rowid, vals] of rows) {
        const cell = this._cell(rowid, encodeRecord(vals));
        if (cur.length && used + cell.length + 2 > cap) flush();
        cur.push(cell); used += cell.length + 2; maxId = rowid;
      }
      if (cur.length || !leaves.length) flush();
      let level = leaves;
      const PER = 200;
      while (level.length > 1) {
        const groups = [];
        for (let i = 0; i < level.length; i += PER) groups.push(level.slice(i, i + PER));
        if (groups.length > 1 && groups[groups.length - 1].length === 1) {
          const last = groups.pop();
          groups[groups.length - 1].push(last[0]);
        }
        level = groups.map(g => {
          const cells = g.slice(0, -1).map(ch => {
            const kb = varintBytes(ch.key);
            const c = new Uint8Array(4 + kb.length);
            new DataView(c.buffer).setUint32(0, ch.page);
            c.set(kb, 4);
            return c;
          });
          const no = this._alloc();
          this.pages[no] = this._page(0x05, cells, 0, g[g.length - 1].page);
          return { page: no, key: g[g.length - 1].key };
        });
      }
      return level[0].page;
    }

    /** rows: [[rowid, [valores das colunas, null na coluna INTEGER PRIMARY KEY]], ...] */
    addTable(name, sql, rows) {
      rows.sort((a, b) => a[0] - b[0]);
      const root = this._buildTree(rows);
      this.master.push(['table', name, name, root, sql]);
    }

    finish() {
      const cells = this.master.map((m, i) => this._cell(i + 1, encodeRecord(m)));
      const total = cells.reduce((s, c) => s + c.length + 2, 0);
      if (total > this.ps - 108) throw new Error('sqlite_master não cabe em uma página');
      const p1 = this._page(0x0d, cells, 100);
      const dv = new DataView(p1.buffer);
      p1.set(te.encode('SQLite format 3\0'), 0);
      dv.setUint16(16, this.ps === 65536 ? 1 : this.ps);
      p1[18] = 1; p1[19] = 1; p1[20] = 0; p1[21] = 64; p1[22] = 32; p1[23] = 32;
      dv.setUint32(24, 1);
      dv.setUint32(28, this.pages.length - 1);
      dv.setUint32(40, 1);
      dv.setUint32(44, 4);
      dv.setUint32(56, 1);
      dv.setUint32(92, 1);
      dv.setUint32(96, 3037000);
      this.pages[1] = p1;
      const out = new Uint8Array((this.pages.length - 1) * this.ps);
      for (let i = 1; i < this.pages.length; i++) out.set(this.pages[i], (i - 1) * this.ps);
      return out;
    }
  }

  return { Reader, Writer, encodeRecord };
})();
if (typeof module !== 'undefined') module.exports = SQLite;

// Agendador no estilo Anki v2 (SM-2 modificado).
// Cartão: {id,nid,did,ord,type(0 novo,1 aprendendo,2 revisão,3 reaprendendo),queue(-1 suspenso,0 novo,1 aprendendo,2 revisão),
//          due,ivl,factor,reps,lapses,step,flag,buried,mod}
const Sched = (() => {
  const ROLLOVER = 4; // hora em que o "dia" vira
  const nowSec = () => Math.floor(Date.now() / 1000);

  function today() {
    const local = Date.now() / 1000 - new Date().getTimezoneOffset() * 60 - ROLLOVER * 3600;
    return Math.floor(local / 86400);
  }
  function dayOf(sec) { return Math.floor((sec - new Date().getTimezoneOffset() * 60 - ROLLOVER * 3600) / 86400); }
  /** Início do dia de estudo atual, em segundos UTC. */
  function dayStartSec() { return today() * 86400 + ROLLOVER * 3600 + new Date().getTimezoneOffset() * 60; }

  const DEFAULT_CFG = () => ({
    newPerDay: 20, revPerDay: 200, learnSteps: [1, 10], lapseSteps: [10],
    gradIvl: 1, easyIvl: 4, startEase: 2500, maxIvl: 36500,
    easyBonus: 1.3, ivlMod: 1.0, hardMod: 1.2, newIvlMod: 0, minLapseIvl: 1,
    leechThreshold: 8, newRandom: false, burySiblings: true, autoAudio: true,
  });

  function fuzz(ivl, on) {
    if (!on || ivl < 3) return ivl;
    const f = ivl < 7 ? 0.15 : ivl < 30 ? 0.1 : 0.05;
    const min = Math.max(2, Math.round(ivl * (1 - f))), max = Math.round(ivl * (1 + f));
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  /** Aplica a resposta (1 errei, 2 difícil, 3 bom, 4 fácil). Devolve {card, leech}. */
  function answer(card, rating, cfg, useFuzz = true) {
    const c = { ...card };
    c.reps++;
    let leech = false;
    if (c.queue === 0) { c.factor = cfg.startEase; c.step = 0; c.type = 1; c.queue = 1; return { card: learn(c, rating, cfg, false), leech }; }
    if (c.queue === 1) return { card: learn(c, rating, cfg, c.type === 3), leech };
    return review(c, rating, cfg, useFuzz);
  }

  function learn(c, r, cfg, relearn) {
    const steps = relearn ? cfg.lapseSteps : cfg.learnSteps;
    c.queue = 1; c.type = relearn ? 3 : 1;
    if (!steps.length) return graduate(c, cfg, r === 4, relearn);
    if (r === 4) return graduate(c, cfg, true, relearn);
    if (r === 1) c.step = 0;
    else if (r === 3) c.step++;
    if (c.step >= steps.length) return graduate(c, cfg, false, relearn);
    let delay = steps[c.step];
    if (r === 2) {
      if (c.step === 0) delay = steps.length > 1 ? (steps[0] + steps[1]) / 2 : steps[0] * 1.5;
    }
    c.due = nowSec() + Math.round(delay * 60);
    return c;
  }

  function graduate(c, cfg, easy, relearn) {
    c.type = 2; c.queue = 2; c.step = 0;
    if (!relearn) c.ivl = easy ? cfg.easyIvl : cfg.gradIvl;
    else if (easy) c.ivl = c.ivl + 1;
    c.due = today() + Math.max(1, c.ivl);
    return c;
  }

  function review(c, r, cfg, useFuzz) {
    const overdue = Math.max(0, today() - c.due);
    const ease = c.factor / 1000;
    let leech = false;
    if (r === 1) {
      c.lapses++;
      c.factor = Math.max(1300, c.factor - 200);
      c.ivl = Math.max(cfg.minLapseIvl, Math.round(c.ivl * cfg.newIvlMod));
      const t = cfg.leechThreshold;
      if (c.lapses >= t && (c.lapses - t) % Math.max(1, Math.floor(t / 2)) === 0) { leech = true; c.queue = -1; c.type = 2; return { card: c, leech }; }
      if (!cfg.lapseSteps.length) { c.due = today() + c.ivl; c.type = 2; c.queue = 2; return { card: c, leech }; }
      c.type = 3; c.queue = 1; c.step = 0;
      c.due = nowSec() + Math.round(cfg.lapseSteps[0] * 60);
      return { card: c, leech };
    }
    const ivl = c.ivl;
    let hard = (ivl + overdue / 4) * cfg.hardMod * cfg.ivlMod;
    let good = (ivl + overdue / 2) * ease * cfg.ivlMod;
    let easy = (ivl + overdue) * ease * cfg.easyBonus * cfg.ivlMod;
    hard = Math.max(Math.round(hard), ivl + 1);
    good = Math.max(Math.round(good), hard + 1);
    easy = Math.max(Math.round(easy), good + 1);
    let n;
    if (r === 2) { n = hard; c.factor = Math.max(1300, c.factor - 150); }
    else if (r === 3) n = good;
    else { n = easy; c.factor += 150; }
    c.ivl = Math.min(fuzz(n, useFuzz), cfg.maxIvl);
    c.due = today() + c.ivl;
    c.type = 2; c.queue = 2;
    return { card: c, leech };
  }

  function fmtSeconds(s) {
    if (s < 60) return '<1min';
    if (s < 3600) return Math.round(s / 60) + 'min';
    return (s / 3600).toFixed(1).replace(/\.0$/, '') + 'h';
  }
  function fmtDays(d) {
    if (d < 30) return d + 'd';
    if (d < 365) return (d / 30).toFixed(1).replace(/\.0$/, '') + 'mês';
    return (d / 365).toFixed(1).replace(/\.0$/, '') + 'a';
  }
  /** Rótulos dos 4 botões. */
  function preview(card, cfg) {
    const out = {};
    for (const r of [1, 2, 3, 4]) {
      const n = answer(card, r, cfg, false).card;
      out[r] = n.queue === 1 ? fmtSeconds(n.due - nowSec()) : fmtDays(n.due - today());
    }
    return out;
  }

  return { today, dayOf, dayStartSec, nowSec, DEFAULT_CFG, answer, preview, fmtDays };
})();
if (typeof module !== 'undefined') module.exports = Sched;

// Renderização de templates do Anki.
const Render = (() => {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function stripHTML(s) {
    return String(s || '')
      .replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      .trim();
  }

  function clozeText(text, n, answer) {
    return text.replace(/\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g, (m, num, content, hint) => {
      if (+num !== n) return content;
      return answer ? `<span class="cloze">${content}</span>` : `<span class="cloze">[${hint || '...'}]</span>`;
    });
  }

  function clozeOrds(text) {
    const set = new Set();
    for (const m of String(text).matchAll(/\{\{c(\d+)::/g)) set.add(+m[1]);
    return [...set].sort((a, b) => a - b);
  }

  function typeCompare(expected, typed) {
    const e = stripHTML(expected);
    if (typed === e) return `<code class="typeGood">${esc(e)}</code>`;
    return `<code class="typeBad">${esc(typed || '')}</code><br>↓<br><code class="typeGood">${esc(e)}</code>`;
  }

  function fieldValue(key, vals, ctx) {
    const parts = key.split(':');
    const name = parts[parts.length - 1];
    const raw = vals[name] ?? '';
    for (const f of parts.slice(0, -1).reverse()) {
      if (f === 'cloze') return clozeText(raw, ctx.cloze, ctx.answer);
      if (f === 'text') return stripHTML(raw);
      if (f === 'hint') return raw ? `<a class="hint" href="#" data-hint>${esc(name)}</a><span class="hintbox" style="display:none">${raw}</span>` : '';
      if (f === 'type') {
        if (!ctx.answer) return '<input id="typeans" class="typeans" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Digite a resposta">';
        const src = ctx.model.isCloze ? clozeOnlyAnswers(raw, ctx.cloze) : raw;
        return typeCompare(src, ctx.typed);
      }
    }
    return raw;
  }
  function clozeOnlyAnswers(text, n) {
    const out = [];
    for (const m of text.matchAll(/\{\{c(\d+)::([\s\S]*?)(?:::[\s\S]*?)?\}\}/g)) if (+m[1] === n) out.push(m[2]);
    return out.join(', ');
  }

  function expand(tpl, vals, ctx) {
    let s = tpl;
    const sec = /\{\{([#^])\s*([^}]+?)\s*\}\}([\s\S]*?)\{\{\/\s*\2\s*\}\}/;
    for (let guard = 0; guard < 200; guard++) {
      const m = sec.exec(s);
      if (!m) break;
      const has = stripHTML(vals[m[2]] || '') !== '' || /<img|\[sound:/i.test(vals[m[2]] || '');
      s = s.slice(0, m.index) + ((m[1] === '#') === has ? m[3] : '') + s.slice(m.index + m[0].length);
    }
    return s.replace(/\{\{\s*([^}#^/][^}]*?)\s*\}\}/g, (all, key) => fieldValue(key, vals, ctx));
  }

  /** Devolve o HTML (corpo) + CSS do cartão. */
  function render(note, model, card, answer, opts = {}) {
    if (!model.tmpls.length) return { html: '', css: model.css };
    const t = model.tmpls[model.isCloze ? 0 : Math.min(card.ord, model.tmpls.length - 1)];
    const vals = {};
    model.flds.forEach((n, i) => { vals[n] = note.flds[i] ?? ''; });
    vals.Tags = note.tags || ''; vals.Deck = opts.deckName || ''; vals.Subdeck = (opts.deckName || '').split('::').pop();
    vals.Type = model.name; vals.Card = t.name;
    const ctx = { model, cloze: card.ord + 1, answer: false, typed: opts.typed };
    const q = expand(t.qfmt, vals, ctx);
    let html = q;
    if (answer) {
      ctx.answer = true;
      vals.FrontSide = q.replace(/<input[^>]*id="typeans"[^>]*>/, '');
      html = expand(t.afmt, vals, ctx);
    }
    html = html.replace(/\[sound:([^\]]+)\]/g, (m, f) => `<a class="replay" href="#" data-sound="${esc(f)}">▶</a>`);
    return { html, css: model.css || '' };
  }

  function sounds(html) {
    return [...html.matchAll(/data-sound="([^"]+)"/g)].map(m => m[1].replace(/&amp;/g, '&'));
  }

  /** Troca src="arquivo" por data: URIs, usando getDataURL(nome) → Promise<string|null>. */
  async function inlineMedia(html, getDataURL) {
    const re = /(<img[^>]*?\ssrc\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
    const found = [...html.matchAll(re)];
    let out = '', last = 0;
    for (const m of found) {
      const name = m[2] ?? m[3] ?? m[4];
      out += html.slice(last, m.index);
      last = m.index + m[0].length;
      if (/^(https?:|data:|blob:)/i.test(name)) { out += m[0]; continue; }
      let url = await getDataURL(name);
      if (!url) { try { url = await getDataURL(decodeURIComponent(name)); } catch (e) { /* ignore */ } }
      out += m[1] + '"' + (url || name) + '"';
    }
    return out + html.slice(last);
  }

  return { render, stripHTML, clozeOrds, clozeText, sounds, inlineMedia, expand };
})();
if (typeof module !== 'undefined') module.exports = Render;

// Armazenamento local (IndexedDB) + estado em memória. Tudo funciona offline.
const Store = (() => {
  let idb;
  const S = { decks: new Map(), models: new Map(), notes: new Map(), cards: new Map(), daily: null, prefs: {} };
  const STORES = ['decks', 'models', 'notes', 'cards', 'revlog', 'media', 'meta'];
  let lastId = 0;
  const newId = () => { let t = Date.now(); if (t <= lastId) t = lastId + 1; lastId = t; return t; };
  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const txDone = t => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });

  async function open() {
    idb = await new Promise((res, rej) => {
      const r = indexedDB.open('meuanki', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        for (const n of ['decks', 'models', 'notes', 'cards', 'revlog']) d.createObjectStore(n, { keyPath: 'id' });
        d.createObjectStore('media', { keyPath: 'name' });
        d.createObjectStore('meta', { keyPath: 'key' });
      };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  }
  const getAll = name => req(idb.transaction(name).objectStore(name).getAll());
  async function putMany(name, arr) {
    if (!arr.length) return;
    const t = idb.transaction(name, 'readwrite'); const st = t.objectStore(name);
    for (const o of arr) st.put(o);
    await txDone(t);
  }
  const put = (name, o) => putMany(name, [o]);
  async function delMany(name, keys) {
    if (!keys.length) return;
    const t = idb.transaction(name, 'readwrite'); const st = t.objectStore(name);
    for (const k of keys) st.delete(k);
    await txDone(t);
  }
  async function clearAll() {
    const t = idb.transaction(STORES, 'readwrite');
    for (const n of STORES) t.objectStore(n).clear();
    await txDone(t);
  }

  async function init() {
    await open();
    try { await navigator.storage?.persist?.(); } catch (e) { /* ignore */ }
    await loadAll();
    if (!S.models.size) await seedModels();
    if (!S.decks.size) await createDeck('Padrão');
    ensureDay();
  }
  async function loadAll() {
    S.decks = new Map((await getAll('decks')).map(x => [x.id, x]));
    S.models = new Map((await getAll('models')).map(x => [x.id, x]));
    S.notes = new Map((await getAll('notes')).map(x => [x.id, x]));
    S.cards = new Map((await getAll('cards')).map(x => [x.id, x]));
    const metas = await getAll('meta');
    const m = metas.find(x => x.key === 'daily');
    S.daily = m ? m.value : null;
    const pr = metas.find(x => x.key === 'prefs');
    S.prefs = pr ? pr.value : {};
  }

  // ---------- Dia / contadores ----------
  function ensureDay() {
    const t = Sched.today();
    if (!S.daily || S.daily.day !== t) { S.daily = { day: t, new: {}, rev: {} }; saveDaily(); }
    return S.daily;
  }
  const saveDaily = () => put('meta', { key: 'daily', value: S.daily });

  // ---------- Baralhos ----------
  async function createDeck(name, id) {
    for (const d of S.decks.values()) if (d.name === name) return d;
    const d = { id: id || newId(), name, cfg: Sched.DEFAULT_CFG() };
    S.decks.set(d.id, d); await put('decks', d); return d;
  }
  const deckList = () => [...S.decks.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt', { numeric: true }));
  const inTree = (d, root) => d.name === root.name || d.name.startsWith(root.name + '::');
  const treeIds = root => new Set([...S.decks.values()].filter(d => inTree(d, root)).map(d => d.id));
  async function saveDeck(d) { S.decks.set(d.id, d); await put('decks', d); }
  async function renameDeck(d, name) {
    const old = d.name;
    const changed = [];
    for (const x of S.decks.values()) {
      if (x.name === old || x.name.startsWith(old + '::')) { x.name = name + x.name.slice(old.length); changed.push(x); }
    }
    await putMany('decks', changed);
  }
  async function deleteDeck(d) {
    const ids = treeIds(d);
    const cards = [...S.cards.values()].filter(c => ids.has(c.did));
    const nids = new Set(cards.map(c => c.nid));
    for (const c of cards) S.cards.delete(c.id);
    // só remove notas que não têm mais cartões
    const still = new Set([...S.cards.values()].map(c => c.nid));
    const dead = [...nids].filter(n => !still.has(n));
    dead.forEach(n => S.notes.delete(n));
    await delMany('cards', cards.map(c => c.id));
    await delMany('notes', dead);
    await delMany('decks', [...ids]);
    ids.forEach(i => S.decks.delete(i));
    if (!S.decks.size) await createDeck('Padrão');
  }

  // ---------- Estatísticas por baralho (inclui subbaralhos) ----------
  function deckStats() {
    const raw = new Map();
    for (const c of S.cards.values()) {
      let b = raw.get(c.did); if (!b) raw.set(c.did, b = { total: 0, mature: 0, young: 0, newC: 0, lrn: 0, susp: 0 });
      b.total++;
      if (c.queue === -1) b.susp++; else if (c.queue === 0) b.newC++; else if (c.queue === 1) b.lrn++; else if (c.ivl >= 21) b.mature++; else b.young++;
    }
    const out = new Map(), decks = [...S.decks.values()];
    for (const root of decks) {
      const a = { total: 0, mature: 0, young: 0, newC: 0, lrn: 0, susp: 0 };
      for (const d of decks) if (inTree(d, root)) { const b = raw.get(d.id); if (b) for (const k in a) a[k] += b[k]; }
      out.set(root.id, a);
    }
    return out;
  }

  // ---------- Contagens ----------
  function counts() {
    const t = Sched.today(), now = Sched.nowSec(), day = ensureDay();
    const raw = new Map();
    for (const c of S.cards.values()) {
      if (c.queue < 0 || (c.buried || 0) > t) continue;
      let b = raw.get(c.did); if (!b) raw.set(c.did, b = { n: 0, l: 0, r: 0 });
      if (c.queue === 0) b.n++;
      else if (c.queue === 1) { if (c.due <= now + 1200) b.l++; }
      else if (c.queue === 2 && c.due <= t) b.r++;
    }
    const out = new Map();
    for (const root of S.decks.values()) {
      let n = 0, l = 0, r = 0, dn = 0, dr = 0;
      for (const d of S.decks.values()) {
        if (!inTree(d, root)) continue;
        const b = raw.get(d.id) || { n: 0, l: 0, r: 0 };
        n += Math.min(b.n, Math.max(0, d.cfg.newPerDay - (day.new[d.id] || 0)));
        r += Math.min(b.r, Math.max(0, d.cfg.revPerDay - (day.rev[d.id] || 0)));
        l += b.l; dn += day.new[d.id] || 0; dr += day.rev[d.id] || 0;
      }
      out.set(root.id, { new: Math.min(n, Math.max(0, root.cfg.newPerDay - dn)), learn: l, review: Math.min(r, Math.max(0, root.cfg.revPerDay - dr)) });
    }
    return out;
  }

  // ---------- Fila de estudo ----------
  function buildQueue(root, mode = 'normal') {
    const t = Sched.today(), now = Sched.nowSec(), day = ensureDay();
    const ids = treeIds(root);
    const mine = [...S.cards.values()].filter(c => ids.has(c.did) && c.queue >= 0);
    const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
    if (mode === 'cram') return { learn: [], rev: shuffle(mine).slice(0, 200), nw: [] };
    if (mode === 'difficult') return { learn: [], rev: mine.filter(c => c.lapses > 0).sort((a, b) => b.lapses - a.lapses).slice(0, 100), nw: [] };
    if (mode === 'ahead') return { learn: [], rev: mine.filter(c => c.queue === 2 && c.due <= t + 7).sort((a, b) => a.due - b.due), nw: [] };
    const ok = c => (c.buried || 0) <= t;
    const learn = mine.filter(c => c.queue === 1 && c.due <= now + 1200).sort((a, b) => a.due - b.due);
    let rev = [], nw = [];
    // "Ordem aleatória" no baralho estudado mistura TODOS os subbaralhos (assuntos alternando ao acaso)
    const mix = !!root.cfg.newRandom;
    const orderedIds = [...ids].sort((a, b) => S.decks.get(a).name.localeCompare(S.decks.get(b).name, 'pt'));
    for (const id of orderedIds) {
      const d = S.decks.get(id), cfg = d.cfg;
      const r = mine.filter(c => c.did === id && c.queue === 2 && c.due <= t && ok(c)).sort((a, b) => a.due - b.due);
      rev.push(...r.slice(0, Math.max(0, cfg.revPerDay - (day.rev[id] || 0))));
      let n = mine.filter(c => c.did === id && c.queue === 0 && ok(c));
      n = (cfg.newRandom || mix) ? shuffle(n) : n.sort((a, b) => a.due - b.due || a.ord - b.ord);
      nw.push(...n.slice(0, Math.max(0, cfg.newPerDay - (day.new[id] || 0))));
    }
    let doneN = 0, doneR = 0;
    for (const id of ids) { doneN += day.new[id] || 0; doneR += day.rev[id] || 0; }
    rev = shuffle(rev.sort((a, b) => a.due - b.due)).slice(0, Math.max(0, root.cfg.revPerDay - doneR));
    if (mix) nw = shuffle(nw);
    nw = nw.slice(0, Math.max(0, root.cfg.newPerDay - doneN));
    return { learn, rev, nw };
  }

  /** Responde um cartão. noSched = modo de revisão livre (não altera o agendamento). */
  async function answerCard(card, rating, timeMs, noSched = false) {
    if (noSched) return { before: card, after: card, noSched: true };
    const deck = S.decks.get(card.did);
    const before = { ...card };
    const { card: after, leech } = Sched.answer(card, rating, deck.cfg);
    after.mod = Sched.nowSec();
    const day = ensureDay();
    const wasNew = before.queue === 0, wasRev = before.queue === 2;
    if (wasNew) day.new[card.did] = (day.new[card.did] || 0) + 1;
    if (wasRev) day.rev[card.did] = (day.rev[card.did] || 0) + 1;
    S.cards.set(after.id, after);
    const rev = { id: newId(), cid: card.id, ease: rating, ivl: after.queue === 1 ? -Math.max(1, after.due - Sched.nowSec()) : after.ivl,
      lastIvl: before.ivl, factor: after.factor, time: Math.min(timeMs, 60000), type: before.queue === 0 || before.queue === 1 ? 0 : (before.type === 3 ? 2 : 1) };
    const buriedPrev = [];
    if (deck.cfg.burySiblings) {
      for (const s of S.cards.values()) if (s.nid === card.nid && s.id !== card.id) { buriedPrev.push([s.id, s.buried || 0]); s.buried = Sched.today() + 1; }
    }
    let tagged = false;
    if (leech) {
      const n = S.notes.get(card.nid);
      if (n && !/\bleech\b/.test(n.tags)) { n.tags = (n.tags + ' leech').trim(); tagged = true; await put('notes', n); }
    }
    await put('cards', after); await put('revlog', rev); await saveDaily();
    await putMany('cards', buriedPrev.map(([id]) => S.cards.get(id)));
    return { before, after, leech, rev, wasNew, wasRev, buriedPrev, tagged };
  }

  async function undoAnswer(rec) {
    if (!rec || rec.noSched) return;
    const day = ensureDay();
    if (rec.wasNew) day.new[rec.before.did] = Math.max(0, (day.new[rec.before.did] || 1) - 1);
    if (rec.wasRev) day.rev[rec.before.did] = Math.max(0, (day.rev[rec.before.did] || 1) - 1);
    S.cards.set(rec.before.id, rec.before);
    for (const [id, b] of rec.buriedPrev) { const c = S.cards.get(id); if (c) c.buried = b; }
    if (rec.tagged) { const n = S.notes.get(rec.before.nid); if (n) { n.tags = n.tags.replace(/\s*\bleech\b/, '').trim(); await put('notes', n); } }
    await put('cards', rec.before); await delMany('revlog', [rec.rev.id]); await saveDaily();
    await putMany('cards', rec.buriedPrev.map(([id]) => S.cards.get(id)).filter(Boolean));
  }

  // ---------- Notas e cartões ----------
  async function seedModels() {
    const css = '.card{font-size:22px;text-align:center}';
    const ms = [
      { id: newId(), name: 'Básico', flds: ['Frente', 'Verso'], css, isCloze: false, tmpls: [{ name: 'Cartão 1', qfmt: '{{Frente}}', afmt: '{{FrontSide}}<hr id=answer>{{Verso}}' }] },
      { id: newId(), name: 'Básico (e cartão invertido)', flds: ['Frente', 'Verso'], css, isCloze: false, tmpls: [
        { name: 'Cartão 1', qfmt: '{{Frente}}', afmt: '{{FrontSide}}<hr id=answer>{{Verso}}' },
        { name: 'Cartão 2', qfmt: '{{Verso}}', afmt: '{{FrontSide}}<hr id=answer>{{Frente}}' }] },
      { id: newId(), name: 'Básico (digite a resposta)', flds: ['Frente', 'Verso'], css, isCloze: false, tmpls: [{ name: 'Cartão 1', qfmt: '{{Frente}}<br>{{type:Verso}}', afmt: '{{Frente}}<hr id=answer>{{type:Verso}}' }] },
      { id: newId(), name: 'Omissão de palavras', flds: ['Texto', 'Extra'], css, isCloze: true, tmpls: [{ name: 'Cloze', qfmt: '{{cloze:Texto}}', afmt: '{{cloze:Texto}}<br>{{Extra}}' }] },
    ];
    for (const m of ms) S.models.set(m.id, m);
    await putMany('models', ms);
  }

  function makeCards(note, model, did, startId) {
    const ords = model.isCloze ? Render.clozeOrds(note.flds[0] || '').map(n => n - 1) : model.tmpls.map((_, i) => i);
    const vals = {}; model.flds.forEach((n, i) => { vals[n] = note.flds[i] ?? ''; });
    let pos = 1; for (const c of S.cards.values()) if (c.queue === 0 && c.due >= pos) pos = c.due + 1;
    const out = [];
    for (const o of ords) {
      if (!model.isCloze) {
        const q = Render.expand(model.tmpls[o].qfmt, vals, { model, cloze: 1, answer: false });
        if (!Render.stripHTML(q) && !/<img/i.test(q)) continue;
      }
      out.push({ id: startId + out.length, nid: note.id, did, ord: o, type: 0, queue: 0, due: pos, ivl: 0, factor: 2500, reps: 0, lapses: 0, step: 0, flag: 0, buried: 0, mod: Sched.nowSec() });
    }
    return out;
  }

  async function addNote(model, did, flds, tags = '') {
    const note = { id: newId(), mid: model.id, guid: (crypto.randomUUID?.() || String(Math.random())).replace(/-/g, '').slice(0, 10), flds, tags: tags.trim(), mod: Sched.nowSec() };
    const first = newId(); lastId += 50;
    const cards = makeCards(note, model, did, first);
    if (!cards.length) return 0;
    S.notes.set(note.id, note); cards.forEach(c => S.cards.set(c.id, c));
    await put('notes', note); await putMany('cards', cards);
    return cards.length;
  }
  async function updateNote(note, flds, tags) {
    note.flds = flds; note.tags = tags.trim(); note.mod = Sched.nowSec();
    const model = S.models.get(note.mid);
    await put('notes', note);
    if (model?.isCloze) { // cria cartões para novas omissões
      const have = new Set([...S.cards.values()].filter(c => c.nid === note.id).map(c => c.ord));
      const any = [...S.cards.values()].find(c => c.nid === note.id);
      const add = makeCards(note, model, any ? any.did : deckList()[0].id, newId()).filter(c => !have.has(c.ord));
      lastId += 50;
      add.forEach(c => S.cards.set(c.id, c)); await putMany('cards', add);
    }
  }
  async function deleteNote(nid) {
    const ids = [...S.cards.values()].filter(c => c.nid === nid).map(c => c.id);
    ids.forEach(i => S.cards.delete(i)); S.notes.delete(nid);
    await delMany('cards', ids); await delMany('notes', [nid]);
  }
  async function setSuspended(card, on) {
    card.queue = on ? -1 : (card.type === 0 ? 0 : card.type === 2 ? 2 : 1);
    await put('cards', card);
  }
  async function resetCard(card) {
    Object.assign(card, { type: 0, queue: 0, ivl: 0, factor: 2500, reps: 0, lapses: 0, step: 0, due: Sched.nowSec() % 100000 });
    await put('cards', card);
  }
  async function moveCards(cards, did) { cards.forEach(c => { c.did = did; }); await putMany('cards', cards); }

  // ---------- Busca ----------
  function search(q, limit = 300) {
    const t = Sched.today(), now = Sched.nowSec();
    const terms = q.trim().split(/\s+/).filter(Boolean);
    const preds = terms.map(raw => {
      const neg = raw.startsWith('-') && raw.length > 1; const term = neg ? raw.slice(1) : raw;
      const low = term.toLowerCase();
      let f;
      if (low.startsWith('tag:')) { const v = low.slice(4); f = (c, n) => n.tags.toLowerCase().split(/\s+/).some(x => x === v || x.startsWith(v + '::') || (v.includes('*') && new RegExp('^' + v.replace(/\*/g, '.*') + '$').test(x))); }
      else if (low.startsWith('deck:')) { const v = low.slice(5).replace(/^"|"$/g, ''); f = c => { const d = S.decks.get(c.did); const nm = d.name.toLowerCase(); return nm === v || nm.startsWith(v + '::'); }; }
      else if (low === 'is:new') f = c => c.queue === 0;
      else if (low === 'is:suspended') f = c => c.queue === -1;
      else if (low === 'is:due') f = c => (c.queue === 2 && c.due <= t) || (c.queue === 1 && c.due <= now + 1200);
      else if (low === 'is:review') f = c => c.type === 2;
      else if (low === 'is:learn') f = c => c.type === 1 || c.type === 3;
      else if (low === 'is:leech') f = (c, n) => /\bleech\b/.test(n.tags);
      else f = (c, n) => n.flds.some(x => x.toLowerCase().includes(low)) ;
      return neg ? (c, n) => !f(c, n) : f;
    });
    const out = [];
    const cards = [...S.cards.values()].sort((a, b) => b.id - a.id);
    for (const c of cards) {
      const n = S.notes.get(c.nid); if (!n) continue;
      if (preds.every(p => p(c, n))) { out.push([c, n]); if (out.length >= limit) break; }
    }
    return out;
  }

  // ---------- Estatísticas ----------
  const getPref = (k, d) => (S.prefs[k] === undefined ? d : S.prefs[k]);
  async function setPref(k, v) { S.prefs[k] = v; await put('meta', { key: 'prefs', value: S.prefs }); }

  async function stats() {
    const all = [...S.cards.values()];
    const t = Sched.today(), now = Sched.nowSec();
    const s = { total: all.length, newC: 0, young: 0, mature: 0, learning: 0, suspended: 0, forecast: Array(14).fill(0) };
    for (const c of all) {
      if (c.queue === -1) s.suspended++;
      else if (c.queue === 0) s.newC++;
      else if (c.queue === 1) s.learning++;
      else if (c.ivl >= 21) s.mature++; else s.young++;
      if (c.queue === 2) { const d = Math.max(0, c.due - t); if (d < 14) s.forecast[d]++; }
    }
    const logs = await getAll('revlog');
    const per = new Map(); let ok = 0, tot = 0, ms = 0;
    for (const r of logs) {
      const sec = r.id / 1000, d = Sched.dayOf(sec);
      let e = per.get(d); if (!e) per.set(d, e = { n: 0, ms: 0 });
      e.n++; e.ms += r.time || 0; ms += r.time || 0; if (r.ease > 1) e.ok = (e.ok || 0) + 1;
      if (sec > now - 30 * 86400 && r.type === 1) { tot++; if (r.ease > 1) ok++; }
    }
    let streak = 0, d = per.has(t) ? t : t - 1;
    while (per.has(d)) { streak++; d--; }
    const days = [...per.keys()].sort((a, b) => a - b);
    let best = 0, run = 0, prev = null;
    for (const x of days) { run = prev !== null && x === prev + 1 ? run + 1 : 1; if (run > best) best = run; prev = x; }
    Object.assign(s, { per, streak, best, activeDays: per.size, totalReviews: logs.length, totalMs: ms, retention: tot ? Math.round(ok * 100 / tot) : null,
      today: per.get(t) || { n: 0, ms: 0 }, studiedToday: per.has(t), todayDay: t });
    return s;
  }

  // ---------- Mídia ----------
  const mediaCache = new Map();
  const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', mp4: 'video/mp4', webm: 'video/webm' };
  async function putMedia(name, blob) {
    mediaCache.delete(name);
    const t = MIME[(name.split('.').pop() || '').toLowerCase()];
    if (t && blob.type !== t) blob = blob.slice(0, blob.size, t);
    await put('media', { name, blob });
  }
  async function getMedia(name) { const r = await req(idb.transaction('media').objectStore('media').get(name)); return r ? r.blob : null; }
  function blobToDataURL(b) { return new Promise((res, rej) => { const f = new FileReader(); f.onload = () => res(f.result); f.onerror = rej; f.readAsDataURL(b); }); }
  async function mediaDataURL(name) {
    if (mediaCache.has(name)) return mediaCache.get(name);
    const b = await getMedia(name); if (!b) return null;
    const u = await blobToDataURL(b);
    if (mediaCache.size > 60) mediaCache.delete(mediaCache.keys().next().value);
    mediaCache.set(name, u); return u;
  }
  const allMediaNames = async () => req(idb.transaction('media').objectStore('media').getAllKeys());

  /** Grava vários registros de uma vez (importação). */
  async function bulk({ decks = [], models = [], notes = [], cards = [], revlog = [] }) {
    decks.forEach(x => S.decks.set(x.id, x)); models.forEach(x => S.models.set(x.id, x));
    notes.forEach(x => S.notes.set(x.id, x)); cards.forEach(x => S.cards.set(x.id, x));
    await putMany('decks', decks); await putMany('models', models); await putMany('notes', notes);
    await putMany('cards', cards); await putMany('revlog', revlog);
  }
  async function resetAll() {
    await clearAll(); S.decks = new Map(); S.models = new Map(); S.notes = new Map(); S.cards = new Map(); S.daily = null;
    await seedModels(); await createDeck('Padrão'); ensureDay();
  }
  const rawRevlog = () => getAll('revlog');
  const rawMedia = () => getAll('media');

  return { S, init, newId, clearAll, loadAll, put, putMany, delMany, deckList, inTree, treeIds, createDeck, saveDeck, renameDeck, deleteDeck,
    getPref, setPref, deckStats, counts, buildQueue, answerCard, undoAnswer, addNote, updateNote, deleteNote, setSuspended, resetCard, moveCards, search, stats,
    resetAll, putMedia, getMedia, mediaDataURL, allMediaNames, bulk, rawRevlog, rawMedia, ensureDay, seedModels };
})();

// Importação/exportação: .apkg (Anki 2.1 legado), texto/CSV e backup completo.
const Apkg = (() => {
  const td = new TextDecoder();
  const SCHEMA = {
    col: 'CREATE TABLE col(id integer primary key, crt integer not null, mod integer not null, scm integer not null, ver integer not null, dty integer not null, usn integer not null, ls integer not null, conf text not null, models text not null, decks text not null, dconf text not null, tags text not null)',
    notes: 'CREATE TABLE notes(id integer primary key, guid text not null, mid integer not null, mod integer not null, usn integer not null, tags text not null, flds text not null, sfld integer not null, csum integer not null, flags integer not null, data text not null)',
    cards: 'CREATE TABLE cards(id integer primary key, nid integer not null, did integer not null, ord integer not null, mod integer not null, usn integer not null, type integer not null, queue integer not null, due integer not null, ivl integer not null, factor integer not null, reps integer not null, lapses integer not null, left integer not null, odue integer not null, odid integer not null, flags integer not null, data text not null)',
    revlog: 'CREATE TABLE revlog(id integer primary key, cid integer not null, usn integer not null, ease integer not null, ivl integer not null, lastIvl integer not null, factor integer not null, time integer not null, type integer not null)',
    graves: 'CREATE TABLE graves(usn integer not null, oid integer not null, type integer not null)',
  };
  const tick = () => new Promise(r => setTimeout(r, 0));
  const safeJSON = (s, d) => { try { return JSON.parse(s); } catch (e) { return d; } };

  async function importFile(file, progress = () => {}) {
    const n = file.name.toLowerCase();
    if (/\.(apkg|colpkg)$/.test(n)) return importApkg(file, progress);
    if (/\.(txt|csv|tsv)$/.test(n)) return importText(file);
    throw new Error('Formato não suportado: ' + file.name);
  }

  async function importApkg(file, progress) {
    progress('Abrindo arquivo…');
    const zip = await JSZip.loadAsync(file);
    const ent = zip.file('collection.anki21') || zip.file('collection.anki2');
    if (!ent) {
      if (zip.file('collection.anki21b')) throw new Error('Este .apkg está no formato novo do Anki. No Anki do computador, exporte novamente marcando "Suportar versões antigas do Anki".');
      throw new Error('Arquivo .apkg inválido (sem coleção).');
    }
    const rd = new SQLite.Reader(await ent.async('uint8array'));
    const col = rd.rows('col')[0];
    if (!col) throw new Error('Coleção vazia');
    const modelsJ = safeJSON(col.models, {}), decksJ = safeJSON(col.decks, {}), dconfJ = safeJSON(col.dconf, {});
    const notesRaw = rd.rows('notes');
    if (!Object.keys(modelsJ).length || (notesRaw.length === 1 && /update to the latest Anki/i.test(String(notesRaw[0].flds)))) {
      throw new Error('Este .apkg está no formato novo do Anki. No Anki do computador, exporte novamente marcando "Suportar versões antigas do Anki".');
    }
    const S = Store.S, res = { notes: 0, cards: 0, skipped: 0, media: 0, decks: 0 };
    progress('Importando modelos e baralhos…');

    // modelos
    const modelMap = new Map(), newModels = [];
    for (const [k, m] of Object.entries(modelsJ)) {
      const flds = (m.flds || []).slice().sort((a, b) => a.ord - b.ord).map(f => f.name);
      const tmpls = (m.tmpls || []).slice().sort((a, b) => a.ord - b.ord).map(t => ({ name: t.name, qfmt: t.qfmt, afmt: t.afmt }));
      const nm = { id: +k, name: m.name || 'Modelo', flds, tmpls, css: m.css || '', isCloze: m.type === 1 };
      const ex = S.models.get(nm.id);
      if (ex && (ex.name !== nm.name || ex.flds.join() !== nm.flds.join() || JSON.stringify(ex.tmpls) !== JSON.stringify(nm.tmpls))) nm.id = Store.newId();
      if (!ex || nm.id !== +k) newModels.push(nm);
      modelMap.set(+k, nm.id);
    }

    // baralhos
    const used = new Set(); const cardsRaw = rd.rows('cards');
    for (const c of cardsRaw) used.add(c.odid ? c.odid : c.did);
    const deckMap = new Map(), newDecks = [];
    for (const [k, d] of Object.entries(decksJ)) {
      if (d.dyn) continue;
      const name = String(d.name).replace(/\x1f/g, '::');
      if (name === 'Default' && !used.has(+k)) continue;
      let deck = [...S.decks.values()].find(x => x.name === name) || newDecks.find(x => x.name === name);
      if (!deck) {
        deck = { id: S.decks.has(+k) ? Store.newId() : +k, name, cfg: Sched.DEFAULT_CFG() };
        applyConf(deck.cfg, dconfJ[String(d.conf)]);
        newDecks.push(deck); res.decks++;
      }
      deckMap.set(+k, deck.id);
    }
    if (!deckMap.size) { const d = { id: Store.newId(), name: 'Importado', cfg: Sched.DEFAULT_CFG() }; newDecks.push(d); deckMap.set(0, d.id); }
    const fallbackDeck = [...deckMap.values()][0];

    // notas
    progress('Importando notas…'); await tick();
    const guids = new Set([...S.notes.values()].map(n => n.guid));
    const noteMap = new Map(), notes = [];
    for (const r of notesRaw) {
      if (guids.has(r.guid)) { res.skipped++; continue; }
      const mid = modelMap.get(r.mid); if (mid === undefined) continue;
      const id = S.notes.has(r.id) || noteMap.has(r.id) ? Store.newId() : r.id;
      noteMap.set(r.id, id);
      notes.push({ id, mid, guid: r.guid, flds: String(r.flds).split('\x1f'), tags: String(r.tags || '').trim(), mod: r.mod });
    }
    res.notes = notes.length;

    // cartões
    progress('Importando cartões…'); await tick();
    const today = Sched.today(), now = Sched.nowSec(), ankiToday = Math.floor((now - col.crt) / 86400);
    const cardMap = new Map(), cards = [];
    const modelOf = new Map(notes.map(n => [n.id, n]));
    for (const r of cardsRaw) {
      const nid = noteMap.get(r.nid); if (nid === undefined) continue;
      const did = deckMap.get(r.odid || r.did) ?? fallbackDeck;
      let { type, queue, due } = r;
      if (queue === 4) queue = type === 0 ? 0 : 2;
      if (queue === 2 || (queue < 0 && type === 2)) due = today + (due - ankiToday);
      else if (queue === 3) { queue = 1; due = now; }
      else if (queue === -2 || queue === -3) queue = type === 0 ? 0 : type === 2 ? 2 : 1;
      if (queue === 1 && due < 1e9) due = now;
      const deck = [...newDecks, ...S.decks.values()].find(d => d.id === did);
      const steps = (type === 3 ? deck?.cfg.lapseSteps : deck?.cfg.learnSteps) || [];
      const step = queue === 1 ? Math.max(0, steps.length - ((r.left || 0) % 1000)) : 0;
      const id = S.cards.has(r.id) || cardMap.has(r.id) ? Store.newId() : r.id;
      cardMap.set(r.id, id);
      cards.push({ id, nid, did, ord: r.ord, type, queue, due, ivl: Math.max(0, r.ivl), factor: r.factor > 0 ? r.factor : 2500, reps: r.reps, lapses: r.lapses, step, flag: 0, buried: 0, mod: r.mod });
    }
    res.cards = cards.length;
    const revlog = rd.rows('revlog').filter(r => cardMap.has(r.cid)).map(r => ({ id: r.id, cid: cardMap.get(r.cid), ease: r.ease, ivl: r.ivl, lastIvl: r.lastIvl, factor: r.factor, time: r.time, type: r.type }));

    progress('Gravando no banco de dados…'); await tick();
    await Store.bulk({ decks: newDecks, models: newModels, notes, cards, revlog });

    // mídia
    const mf = zip.file('media');
    if (mf) {
      const map = safeJSON(await mf.async('string'), {});
      const entries = Object.entries(map); let i = 0;
      for (const [k, name] of entries) {
        const f = zip.file(k); if (!f) continue;
        await Store.putMedia(name, await f.async('blob')); res.media++;
        if (++i % 25 === 0) { progress(`Importando mídia ${i}/${entries.length}…`); await tick(); }
      }
    }
    return res;
  }

  function applyConf(cfg, c) {
    if (!c) return;
    const n = c.new || {}, r = c.rev || {}, l = c.lapse || {};
    if (n.perDay != null) cfg.newPerDay = n.perDay;
    if (r.perDay != null) cfg.revPerDay = r.perDay;
    if (Array.isArray(n.delays)) cfg.learnSteps = n.delays;
    if (Array.isArray(l.delays)) cfg.lapseSteps = l.delays;
    if (Array.isArray(n.ints) && n.ints.length >= 2) { cfg.gradIvl = n.ints[0]; cfg.easyIvl = n.ints[1]; }
    if (n.initialFactor) cfg.startEase = n.initialFactor;
    if (r.maxIvl) cfg.maxIvl = r.maxIvl;
    if (r.ease4) cfg.easyBonus = r.ease4;
    if (r.ivlFct) cfg.ivlMod = r.ivlFct;
    if (r.hardFactor) cfg.hardMod = r.hardFactor;
    if (l.mult != null) cfg.newIvlMod = l.mult;
    if (l.minInt) cfg.minLapseIvl = l.minInt;
    if (l.leechFails) cfg.leechThreshold = l.leechFails;
    if (n.order === 0) cfg.newRandom = true;
    if (n.bury != null) cfg.burySiblings = !!n.bury;
  }

  // ---------- Texto / CSV ----------
  function parseDelimited(text, sep) {
    const rows = []; let row = [], cur = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch;
      } else if (ch === '"' && cur === '') q = true;
      else if (ch === sep) { row.push(cur); cur = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cur); cur = ''; if (row.length > 1 || row[0] !== '') rows.push(row); row = [];
      } else cur += ch;
    }
    row.push(cur); if (row.length > 1 || row[0] !== '') rows.push(row);
    return rows;
  }

  async function importText(file) {
    let text = await file.text();
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const lines = text.split(/\r?\n/);
    const head = {}; let body = [];
    for (const l of lines) { const m = /^#(\w[\w ]*):(.*)$/.exec(l); if (m && !body.length) head[m[1].trim().toLowerCase()] = m[2].trim(); else if (!l.startsWith('#')) body.push(l); }
    const sepName = head.separator;
    const first = body.find(l => l.trim()) || '';
    const sep = ({ tab: '\t', comma: ',', semicolon: ';', pipe: '|', space: ' ' })[sepName] || (first.includes('\t') ? '\t' : first.includes(';') ? ';' : ',');
    const html = head.html === 'true';
    const rows = parseDelimited(body.join('\n'), sep);
    const tagCol = head['tags column'] ? +head['tags column'] - 1 : -1;
    const model = [...Store.S.models.values()].find(m => m.name === 'Básico');
    const deck = await Store.createDeck(file.name.replace(/\.[^.]+$/, ''));
    let n = 0, skipped = 0;
    const esc = s => html ? s : s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
    for (const r of rows) {
      if (r.length < 2) { skipped++; continue; }
      const tags = tagCol >= 0 ? (r[tagCol] || '') : '';
      const f = r.filter((_, i) => i !== tagCol);
      n += await Store.addNote(model, deck.id, [esc(f[0]), esc(f.slice(1).join(' '))], tags);
    }
    return { notes: n, cards: n, skipped, media: 0, decks: 1 };
  }

  // ---------- Exportação ----------
  async function sha1int(s) {
    try {
      const h = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
      return parseInt([...new Uint8Array(h).slice(0, 4)].map(b => b.toString(16).padStart(2, '0')).join(''), 16);
    } catch (e) { return 0; }
  }

  async function exportApkg(root, { scheduling = true } = {}, progress = () => {}) {
    const S = Store.S;
    const decks = Store.deckList().filter(d => Store.inTree(d, root));
    const ids = new Set(decks.map(d => d.id));
    const cards = [...S.cards.values()].filter(c => ids.has(c.did));
    const noteIds = new Set(cards.map(c => c.nid));
    const notes = [...noteIds].map(i => S.notes.get(i)).filter(Boolean);
    const usedModels = new Set(notes.map(n => n.mid));
    const today = Sched.today(), now = Sched.nowSec();
    const OFF = 3650, crt = Sched.dayStartSec() - OFF * 86400;
    const mj = {};
    for (const mid of usedModels) {
      const m = S.models.get(mid); if (!m) continue;
      mj[mid] = {
        id: mid, name: m.name, type: m.isCloze ? 1 : 0, mod: now, usn: -1, sortf: 0, did: decks[0].id, css: m.css || '', latexPre: '', latexPost: '', latexsvg: false, tags: [], vers: [],
        req: m.isCloze ? [[0, 'all', [0]]] : m.tmpls.map((t, i) => [i, 'any', m.flds.map((f, j) => (t.qfmt.includes('{{' + f + '}}') || t.qfmt.includes(':' + f + '}}') || t.qfmt.includes('#' + f + '}}')) ? j : -1).filter(j => j >= 0)]),
        flds: m.flds.map((name, ord) => ({ name, ord, sticky: false, rtl: false, font: 'Arial', size: 20, media: [] })),
        tmpls: m.tmpls.map((t, ord) => ({ name: t.name, ord, qfmt: t.qfmt, afmt: t.afmt, bqfmt: '', bafmt: '', did: null, bfont: '', bsize: 0 })),
      };
    }
    const dj = { 1: { id: 1, name: 'Default', mod: now, usn: -1, conf: 1, desc: '', dyn: 0, collapsed: false, extendNew: 10, extendRev: 50, lrnToday: [0, 0], newToday: [0, 0], revToday: [0, 0], timeToday: [0, 0] } };
    for (const d of decks) dj[d.id] = { id: d.id, name: d.name.replace(/::/g, '\x1f'), mod: now, usn: -1, conf: 1, desc: '', dyn: 0, collapsed: false, extendNew: 10, extendRev: 50, lrnToday: [0, 0], newToday: [0, 0], revToday: [0, 0], timeToday: [0, 0] };
    const c0 = root.cfg;
    const dconf = { 1: { id: 1, name: 'Padrão', mod: 0, usn: 0, maxTaken: 60, autoplay: true, timer: 0, replayq: true, dyn: false,
      new: { bury: c0.burySiblings, delays: c0.learnSteps, initialFactor: c0.startEase, ints: [c0.gradIvl, c0.easyIvl, 7], order: c0.newRandom ? 0 : 1, perDay: c0.newPerDay, separate: true },
      rev: { bury: c0.burySiblings, ease4: c0.easyBonus, fuzz: 0.05, ivlFct: c0.ivlMod, maxIvl: c0.maxIvl, perDay: c0.revPerDay, hardFactor: c0.hardMod, minSpace: 1 },
      lapse: { delays: c0.lapseSteps, leechAction: 0, leechFails: c0.leechThreshold, minInt: c0.minLapseIvl, mult: c0.newIvlMod } } };
    const conf = { activeDecks: [1], curDeck: 1, newSpread: 0, collapseTime: 1200, timeLim: 0, estTimes: true, dueCounts: true, curModel: null, nextPos: 1, sortType: 'noteFld', sortBackwards: false, addToCur: true, dayLearnFirst: false };

    progress('Montando banco de dados…'); await tick();
    const w = new SQLite.Writer(4096);
    w.addTable('col', SCHEMA.col, [[1, [null, crt, now * 1000, now * 1000, 11, 0, 0, 0, JSON.stringify(conf), JSON.stringify(mj), JSON.stringify(dj), JSON.stringify(dconf), '{}']]]);
    const noteRows = [];
    for (const n of notes) {
      const sf = Render.stripHTML(n.flds[0] || '');
      noteRows.push([n.id, [null, n.guid, n.mid, n.mod || now, -1, n.tags ? ' ' + n.tags + ' ' : '', n.flds.join('\x1f'), sf, await sha1int(sf), 0, '']]);
    }
    w.addTable('notes', SCHEMA.notes, noteRows);
    w.addTable('cards', SCHEMA.cards, cards.map(c => {
      let { type, queue, due, ivl, factor, reps, lapses } = c, left = 0;
      if (!scheduling) { type = 0; queue = 0; due = c.ord + 1; ivl = 0; factor = 0; reps = 0; lapses = 0; }
      else if (queue === 2 || (queue < 0 && type === 2)) due = due - today + OFF;
      else if (queue === 1) { const st = (type === 3 ? S.decks.get(c.did).cfg.lapseSteps : S.decks.get(c.did).cfg.learnSteps).length; left = Math.max(1, st - c.step) * 1001; }
      else if (queue === 0 || type === 0) { due = Math.max(0, due); factor = 0; }
      return [c.id, [null, c.nid, c.did, c.ord, c.mod || now, -1, type, queue, due, ivl, factor, reps, lapses, left, 0, 0, 0, '']];
    }));
    let revRows = [];
    if (scheduling) {
      const cs = new Set(cards.map(c => c.id));
      revRows = (await Store.rawRevlog()).filter(r => cs.has(r.cid)).map(r => [r.id, [null, r.cid, -1, r.ease, r.ivl, r.lastIvl, r.factor, r.time, r.type]]);
    }
    w.addTable('revlog', SCHEMA.revlog, revRows);
    w.addTable('graves', SCHEMA.graves, []);
    const dbBytes = w.finish();

    const zip = new JSZip();
    zip.file('collection.anki2', dbBytes);
    const media = {}; let idx = 0; const seen = new Set();
    const re = /(?:src\s*=\s*["']?([^"'>\s]+)|\[sound:([^\]]+)\])/gi;
    for (const n of notes) {
      for (const f of n.flds) for (const m of f.matchAll(re)) {
        let name = m[1] || m[2]; if (!name || /^(https?:|data:)/i.test(name) || seen.has(name)) continue;
        let blob = await Store.getMedia(name);
        if (!blob) { try { name = decodeURIComponent(name); blob = await Store.getMedia(name); } catch (e) { /* ignore */ } }
        if (!blob || seen.has(name)) continue;
        seen.add(name); zip.file(String(idx), blob); media[idx] = name; idx++;
      }
    }
    zip.file('media', JSON.stringify(media));
    progress('Compactando…'); await tick();
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 3 } });
    return { blob, name: root.name.replace(/::/g, ' - ').replace(/[\/\\:*?"<>|]/g, '-') + '.apkg', cards: cards.length, notes: notes.length, media: idx };
  }

  function exportText(root) {
    const S = Store.S; const seen = new Set(); let out = '#separator:tab\n#html:true\n#tags column:3\n';
    for (const c of S.cards.values()) {
      if (!Store.inTree(S.decks.get(c.did), root) || seen.has(c.nid)) continue; seen.add(c.nid);
      const n = S.notes.get(c.nid); if (!n) continue;
      const cl = s => '"' + String(s).replace(/"/g, '""') + '"';
      out += [cl(n.flds[0] || ''), cl(n.flds.slice(1).join(' ')), n.tags].join('\t') + '\n';
    }
    return { blob: new Blob([out], { type: 'text/plain' }), name: root.name.replace(/::/g, ' - ') + '.txt', notes: seen.size };
  }

  // ---------- Backup completo ----------
  async function backup(progress = () => {}) {
    const S = Store.S, zip = new JSZip();
    zip.file('data.json', JSON.stringify({ v: 1, decks: [...S.decks.values()], models: [...S.models.values()], notes: [...S.notes.values()], cards: [...S.cards.values()], daily: S.daily, prefs: S.prefs }));
    zip.file('revlog.json', JSON.stringify(await Store.rawRevlog()));
    let i = 0; const media = await Store.rawMedia();
    for (const m of media) { zip.file('media/' + m.name, m.blob); if (++i % 50 === 0) progress(`Mídia ${i}/${media.length}`); }
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 1 } });
    const d = new Date(); const p = x => String(x).padStart(2, '0');
    return { blob, name: `recly-backup-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.zip` };
  }

  async function restore(file, progress = () => {}) {
    const zip = await JSZip.loadAsync(file);
    const df = zip.file('data.json'); if (!df) throw new Error('Não é um backup do Recly');
    const data = JSON.parse(await df.async('string'));
    const rev = zip.file('revlog.json') ? JSON.parse(await zip.file('revlog.json').async('string')) : [];
    await Store.clearAll();
    await Store.bulk({ decks: data.decks, models: data.models, notes: data.notes, cards: data.cards, revlog: rev });
    await Store.put('meta', { key: 'daily', value: data.daily });
    if (data.prefs) await Store.put('meta', { key: 'prefs', value: data.prefs });
    let i = 0; const names = Object.keys(zip.files).filter(n => n.startsWith('media/') && !zip.files[n].dir);
    for (const n of names) { await Store.putMedia(n.slice(6), await zip.file(n).async('blob')); if (++i % 25 === 0) { progress(`Mídia ${i}/${names.length}`); await tick(); } }
    await Store.loadAll(); Store.ensureDay();
    return { notes: data.notes.length, cards: data.cards.length, media: names.length };
  }

  return { importFile, exportApkg, exportText, backup, restore };
})();

// Loja: lê o catálogo (catalog.json no próprio site). A compra acontece na Kiwify; o cliente importa o .apkg recebido.
const Shop = (() => {
  const CK = 'meuanki.catalog'; // chave antiga mantida para não perder o cache
  const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } };
  async function catalog() {
    try {
      const r = await fetch('catalog.json?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) throw new Error('http ' + r.status);
      const j = await r.json(); lsSet(CK, JSON.stringify(j)); return { cat: j, offline: false };
    } catch (e) {
      try { return { cat: JSON.parse(lsGet(CK) || 'null'), offline: true }; } catch (e2) { return { cat: null, offline: true }; }
    }
  }
  return { catalog };
})();

// Instalação na tela inicial: Android/Chrome usa o prompt nativo; iPhone mostra o guia.
let installPrompt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; });
window.addEventListener('appinstalled', () => { installPrompt = null; if (typeof currentTab !== 'undefined' && currentTab === 'more') refresh(); });
const isStandalone = () => !!(window.navigator.standalone || matchMedia('(display-mode: standalone)').matches);
function platformInfo() {
  const ua = navigator.userAgent || '';
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const inApp = /Instagram|FBAN|FBAV|FB_IAB|Line\/|TikTok|musical_ly|WhatsApp|LinkedInApp|Snapchat|Twitter/i.test(ua);
  const chromeIOS = ios && /CriOS/.test(ua), otherIOS = ios && /FxiOS|EdgiOS|OPiOS/.test(ua);
  return { ios, inApp, chromeIOS, otherIOS, ipad: /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) };
}
const SVG_SHARE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg>';
const SVG_ADD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/></svg>';
const SVG_DOTS = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';

async function installApp() {
  if (isStandalone()) return alertBox('O Recly já está instalado na sua tela inicial. 🎉', 'Instalado');
  if (installPrompt) {
    const p = installPrompt; installPrompt = null;
    try { await p.prompt(); const r = await p.userChoice; if (r && r.outcome === 'accepted') toast('Recly instalado ✓'); } catch (e) { installGuide(); }
    return refresh();
  }
  installGuide();
}

function installGuide() {
  const pf = platformInfo();
  const step = (n, icon, title, sub) => h('li', { class: 'ig-step' }, h('span', { class: 'ig-n' }, String(n)),
    h('div', null, h('b', null, title, icon ? h('span', { class: 'ig-ico', html: icon }) : null), sub ? h('small', null, sub) : null));
  let body;
  if (pf.inApp) {
    body = [h('p', { class: 'muted' }, 'Você abriu o Recly dentro de outro app (Instagram, WhatsApp…). Para instalar, abra no navegador:'),
      h('ol', { class: 'ig-list' },
        step(1, SVG_DOTS, 'Toque no menu ', 'Fica no canto da tela (••• ou ⋮).'),
        step(2, null, pf.ios ? 'Escolha “Abrir no Safari”' : 'Escolha “Abrir no navegador”'),
        step(3, null, 'Toque de novo em “Instalar na tela inicial”', 'Na aba Mais do Recly.')),
      h('button', { class: 'btn wide', onclick: async () => { try { await navigator.clipboard.writeText(location.href); toast('Link copiado'); } catch (e) { toast(location.href); } } }, '🔗 Copiar link do Recly')];
  } else if (pf.ios) {
    const where = pf.chromeIOS ? 'no canto superior direito, ao lado do endereço' : pf.ipad ? 'no topo do Safari' : 'na barra do Safari (embaixo ou em cima)';
    body = [h('p', { class: 'muted' }, 'São só 3 toques. O ícone do Recly vai aparecer junto com os seus apps.'),
      h('ol', { class: 'ig-list' },
        step(1, SVG_SHARE, 'Toque em Compartilhar ', `Fica ${where}. Se não aparecer, toque em ••• e depois em Compartilhar.`),
        step(2, SVG_ADD, 'Toque em “Adicionar à Tela de Início” ', 'Se não estiver visível, role a lista para baixo (ou toque em “Ver mais”).'),
        step(3, null, 'Toque em “Adicionar”', 'No canto superior direito. Pronto!')),
      pf.otherIOS ? h('p', { class: 'muted s' }, 'Se o seu navegador não tiver essa opção, abra o Recly no Safari.') : null];
  } else {
    body = [h('p', { class: 'muted' }, 'Instale pelo menu do navegador:'),
      h('ol', { class: 'ig-list' },
        step(1, SVG_DOTS, 'Abra o menu do navegador ', 'Ícone ⋮ ou ••• no canto da tela.'),
        step(2, SVG_ADD, 'Toque em “Instalar app” ', 'Ou “Adicionar à tela inicial”.'),
        step(3, null, 'Confirme em “Instalar”'))];
  }
  const m = modal([h('div', { class: 'ig-head' }, h('img', { src: 'apple-touch-icon.png', alt: '' }), h('div', null, h('h3', null, 'Instalar o Recly'), h('small', null, 'Abre em tela cheia e funciona offline'))),
    ...body, h('button', { class: 'btn primary wide', onclick: () => m.close() }, 'Entendi')]);
}

function installCard() {
  if (isStandalone()) return h('div', { class: 'card2 ig-card ok' }, h('span', { class: 'ig-big' }, '✓'), h('div', null, h('b', null, 'Recly instalado'), h('small', null, 'O app está na sua tela inicial e funciona offline.')));
  return h('button', { class: 'card2 ig-card', onclick: installApp }, h('img', { src: 'apple-touch-icon.png', alt: '' }),
    h('div', null, h('b', null, 'Instalar na tela inicial'), h('small', null, installPrompt ? 'Instale com um toque' : 'Tenha o Recly como um app no seu celular')), h('span', { class: 'ig-go' }, '›'));
}

// Interface: utilitários, lista de baralhos e tela de estudo.
const $ = (s, el = document) => el.querySelector(s);
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'value') continue;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  if (props && 'value' in props) el.value = props.value;
  return el;
}
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------- Diálogos ----------
function modal(content, { full = false } = {}) {
  const ov = h('div', { class: 'overlay' });
  const box = h('div', { class: 'sheet' + (full ? ' full' : '') }, content);
  ov.append(box);
  const api = { el: box, close() { ov.remove(); } };
  ov.addEventListener('click', e => { if (e.target === ov) api.close(); });
  document.body.append(ov);
  return api;
}
function alertBox(msg, title = 'Aviso') {
  return new Promise(res => {
    const m = modal([h('h3', null, title), h('p', { class: 'pre' }, msg), h('div', { class: 'row end' }, h('button', { class: 'btn primary', onclick: () => { m.close(); res(); } }, 'OK'))]);
  });
}
function confirmBox(msg, ok = 'Confirmar', danger = false) {
  return new Promise(res => {
    const m = modal([h('p', { class: 'pre' }, msg), h('div', { class: 'row end' },
      h('button', { class: 'btn', onclick: () => { m.close(); res(false); } }, 'Cancelar'),
      h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => { m.close(); res(true); } }, ok))]);
  });
}
function promptBox(title, value = '', placeholder = '') {
  return new Promise(res => {
    const inp = h('input', { type: 'text', placeholder, value, class: 'input' });
    const m = modal([h('h3', null, title), inp, h('div', { class: 'row end' },
      h('button', { class: 'btn', onclick: () => { m.close(); res(null); } }, 'Cancelar'),
      h('button', { class: 'btn primary', onclick: () => { m.close(); res(inp.value.trim()); } }, 'OK'))]);
    setTimeout(() => inp.focus(), 50);
  });
}
function toast(msg) {
  const t = h('div', { class: 'toast' }, msg); document.body.append(t); setTimeout(() => t.remove(), 2600);
}
function busy(text) {
  const p = h('p', { class: 'pre' }, text);
  const m = modal([h('div', { class: 'spinner' }), p]);
  return { set(t) { p.textContent = t; }, close: m.close };
}
/** Etapa final para salvar um arquivo gerado (compartilhar / baixar). */
function saveFileDialog(blob, name, extra = '') {
  const file = new File([blob], name, { type: 'application/octet-stream' });
  const canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
  const mb = (blob.size / 1048576).toFixed(1);
  const download = () => {
    const a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  };
  const m = modal([h('h3', null, 'Arquivo pronto'), h('p', { class: 'pre' }, `${name}\n${mb} MB${extra ? '\n' + extra : ''}`),
    h('div', { class: 'col' },
      canShare ? h('button', { class: 'btn primary', onclick: async () => { try { await navigator.share({ files: [file] }); } catch (e) { if (e.name !== 'AbortError') download(); } } }, 'Compartilhar / Salvar em Arquivos') : null,
      h('button', { class: canShare ? 'btn' : 'btn primary', onclick: download }, 'Baixar'),
      h('button', { class: 'btn', onclick: () => m.close() }, 'Fechar'))]);
}
function pickFiles(multiple = true) {
  return new Promise(res => {
    const i = h('input', { type: 'file', multiple, style: 'display:none' });
    i.addEventListener('change', () => { res([...i.files]); i.remove(); });
    document.body.append(i); i.click();
  });
}

// ---------- Casca do app ----------
const TABS = [['decks', '📚', 'Baralhos'], ['browse', '🔍', 'Navegar'], ['add', '➕', 'Adicionar'], ['stats', '📊', 'Estatísticas'], ['shop', '🛍️', 'Loja'], ['more', '⚙️', 'Mais']];
let currentTab = 'decks';
function shell() {
  const app = $('#app'); app.innerHTML = '';
  app.append(h('main', { id: 'view' }), h('nav', { class: 'tabs' }, TABS.map(([id, ic, label]) =>
    h('button', { class: 'tab', 'data-tab': id, onclick: () => go(id) }, h('span', { class: 'ic' }, ic), h('span', null, label)))));
}
function go(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  const v = $('#view'); v.innerHTML = ''; v.scrollTop = 0;
  ({ decks: viewDecks, browse: viewBrowse, add: viewAdd, stats: viewStats, shop: viewShop, more: viewMore })[tab](v);
}
const refresh = () => go(currentTab);

// ---------- Baralhos ----------
async function doImport() {
  const files = await pickFiles(); if (!files.length) return;
  const b = busy('Importando…'); const msgs = [];
  for (const f of files) {
    try {
      const r = await Apkg.importFile(f, t => b.set(f.name + '\n' + t));
      msgs.push(`✓ ${f.name}: ${r.notes} notas, ${r.cards} cartões, ${r.media} arquivos de mídia` + (r.skipped ? ` (${r.skipped} já existiam)` : ''));
    } catch (e) { console.error(e); msgs.push(`✗ ${f.name}: ${e.message}`); }
  }
  b.close(); await alertBox(msgs.join('\n\n'), 'Importação'); refresh();
}

function exportSheet(d) {
  const run = async (kind) => {
    m.close(); const b = busy('Gerando arquivo…');
    try {
      let r;
      if (kind === 'txt') r = Apkg.exportText(d);
      else r = await Apkg.exportApkg(d, { scheduling: kind === 'apkg' }, t => b.set(t));
      b.close(); saveFileDialog(r.blob, r.name, `${r.notes} notas` + (r.cards ? `, ${r.cards} cartões` : ''));
    } catch (e) { console.error(e); b.close(); alertBox('Erro ao exportar: ' + e.message); }
  };
  const m = modal([h('h3', null, 'Exportar “' + d.name + '”'), h('div', { class: 'col' },
    h('button', { class: 'btn primary', onclick: () => run('apkg') }, 'Baralho com progresso (.apkg)'),
    h('button', { class: 'btn', onclick: () => run('apkg-clean') }, 'Baralho sem progresso (.apkg)'),
    h('button', { class: 'btn', onclick: () => run('txt') }, 'Texto (.txt)'),
    h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'))]);
}

// ---------- Estudo ----------
const CARD_BASE = `html{background:transparent}body{margin:0;padding:14px;font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:20px;text-align:center;line-height:1.4;overflow-wrap:anywhere;box-sizing:border-box;min-height:100vh;display:flex;flex-direction:column;justify-content:center;-webkit-text-size-adjust:100%}#qa{width:100%}
img{max-width:100%;height:auto}hr{border:0;border-top:1px solid #8884;margin:16px 0}.cloze{font-weight:bold;color:#2563eb}
.replay{text-decoration:none;font-size:22px;margin:0 6px;color:inherit}a.hint{color:#2563eb}
.typeans{font-size:18px;width:92%;padding:10px;border-radius:10px;border:1px solid #888;background:transparent;color:inherit;box-sizing:border-box}
code.typeGood{background:#c7f0c7;color:#000;padding:2px 6px;border-radius:4px;font-size:inherit}code.typeBad{background:#f4c7c7;color:#000;padding:2px 6px;border-radius:4px;font-size:inherit}`;
// Ponte entre o cartão (iframe isolado) e o app. Os scripts do modelo rodam normalmente dentro do iframe.
const CARD_BRIDGE = `(function(){var P=function(m){try{parent.postMessage(m,'*')}catch(e){}};window.pycmd=window.pycmd||function(){};
document.addEventListener('click',function(e){var t=e.target,a=t.closest&&t.closest('a.replay');if(a){e.preventDefault();P({t:'sound',name:a.getAttribute('data-sound')});return}
var hn=t.closest&&t.closest('a.hint');if(hn){e.preventDefault();hn.style.display='none';var n=hn.nextElementSibling;if(n)n.style.display='inline'}},true);
var ti=document.getElementById('typeans');if(ti){ti.addEventListener('input',function(){P({t:'typed',v:ti.value})});ti.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();P({t:'key',k:'Enter'})}})}
document.addEventListener('keydown',function(e){if(e.target&&e.target.tagName==='INPUT')return;P({t:'key',k:e.key})})})();`;
function cardDoc(html, css, night) {
  const cls = 'card' + (night ? ' nightMode night_mode' : '');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark">` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https: http:; media-src data: blob: https:; font-src data: https:">` +
    `<style>${CARD_BASE}${css || ''}</style></head><body class="${cls}"><div id="qa">${html}</div><script>${CARD_BRIDGE}<\/script></body></html>`;
}
const darkMode = () => window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches;
let audio = null;
async function playSound(name) {
  try {
    const b = await Store.getMedia(name); if (!b) return;
    if (audio) { audio.pause(); URL.revokeObjectURL(audio.src); }
    audio = new Audio(URL.createObjectURL(b)); await audio.play();
  } catch (e) { /* autoplay bloqueado */ }
}

function startStudy(deck, mode = 'normal') {
  const noSched = mode === 'cram';
  Store.setPref('lastDeck', deck.id);
  let q = Store.buildQueue(deck, mode), cur = null, showing = false, startedAt = 0, history = [], typed;
  const counts = h('div', { class: 'scounts' });
  const frame = h('iframe', { class: 'cardframe', title: 'cartão', sandbox: 'allow-scripts allow-popups allow-popups-to-escape-sandbox' });
  const scroller = h('div', { class: 'cardscroll' }, frame);
  const bottom = h('div', { class: 'sbottom' });
  const root = h('div', { class: 'study' },
    h('div', { class: 'stop' }, h('button', { class: 'btn small', onclick: exit }, '‹ Sair'), counts,
      h('button', { class: 'btn small', onclick: menu }, '•••')), scroller, bottom);
  document.body.append(root);
  const onMsg = ev => {
    if (ev.source !== frame.contentWindow || !ev.data) return;
    const d = ev.data;
    if (d.t === 'sound') playSound(String(d.name));
    else if (d.t === 'typed') typed = String(d.v);
    else if (d.t === 'key') handleKey(String(d.k));
  };
  window.addEventListener('message', onMsg);

  function exit() { document.removeEventListener('keydown', onKey); window.removeEventListener('message', onMsg); if (audio) audio.pause(); root.remove(); refresh(); }
  const sibling = id => c => c.nid !== id;
  function pick() {
    const now = Sched.nowSec();
    let i = q.learn.findIndex(c => c.due <= now);
    if (i >= 0) return q.learn.splice(i, 1)[0];
    if (q.rev.length) return q.rev.shift();
    if (q.nw.length) return q.nw.shift();
    if (q.learn.length) { q.learn.sort((a, b) => a.due - b.due); return q.learn.shift(); }
    return null;
  }
  function updCounts() {
    const l = q.learn.length + (cur && cur.queue === 1 ? 1 : 0), n = q.nw.length + (cur && cur.queue === 0 ? 1 : 0), r = q.rev.length + (cur && cur.queue === 2 ? 1 : 0);
    counts.innerHTML = `<span class="n">${n}</span> <span class="l">${l}</span> <span class="r">${r}</span>`;
    if (noSched) counts.innerHTML = `<span class="r">${q.rev.length + (cur ? 1 : 0)}</span>`;
  }
  async function draw(answer) {
    const note = Store.S.notes.get(cur.nid), model = Store.S.models.get(note.mid), dk = Store.S.decks.get(cur.did);
    const r = Render.render(note, model, cur, answer, { deckName: dk.name, typed });
    const html = await Render.inlineMedia(r.html, Store.mediaDataURL);
    frame.srcdoc = cardDoc(html, r.css, darkMode());
    return { r, html };
  }
  let qSounds = [];
  async function show() {
    cur = pick(); updCounts();
    if (!cur) { finished(); return; }
    showing = false; typed = ''; startedAt = Date.now();
    const { r } = await draw(false);
    qSounds = Render.sounds(r.html);
    if (dk().cfg.autoAudio && qSounds[0]) playSound(qSounds[0]);
    bottom.innerHTML = '';
    bottom.append(h('button', { class: 'btn primary big wide', onclick: reveal }, 'Mostrar resposta'));
  }
  const dk = () => Store.S.decks.get(cur.did);
  async function reveal() {
    if (!cur || showing) return;
    showing = true;
    const { r } = await draw(true);
    const aSounds = Render.sounds(r.html).filter(s => !qSounds.includes(s));
    if (dk().cfg.autoAudio && aSounds[0]) playSound(aSounds[0]);
    const pv = Sched.preview(cur, dk().cfg);
    const mk = (n, label, cls) => h('button', { class: 'ans ' + cls, onclick: () => rate(n) }, h('small', null, pv[n]), label);
    bottom.innerHTML = '';
    bottom.append(mk(1, 'Errei', 'a1'), mk(2, 'Difícil', 'a2'), mk(3, 'Bom', 'a3'), mk(4, 'Fácil', 'a4'));
  }
  async function rate(n) {
    if (!showing || !cur) return;
    const card = cur; showing = false;
    const rec = await Store.answerCard(card, n, Date.now() - startedAt, noSched);
    history.push(rec);
    const after = rec.after;
    if (!noSched) {
      if (dk().cfg.burySiblings) { q.rev = q.rev.filter(sibling(card.nid)); q.nw = q.nw.filter(sibling(card.nid)); }
      if (after.queue === 1) q.learn.push(after);
      if (rec.leech) toast('Cartão sanguessuga: suspenso');
    } else if (n === 1) q.rev.push(card);
    cur = null; show();
  }
  async function undo() {
    const rec = history.pop(); if (!rec) { toast('Nada para desfazer'); return; }
    await Store.undoAnswer(rec);
    if (!noSched) {
      q = Store.buildQueue(deck, mode);
      for (const k of ['learn', 'rev', 'nw']) q[k] = q[k].filter(c => c.id !== rec.before.id);
    }
    if (cur) { const c = Store.S.cards.get(cur.id) || cur; (c.queue === 1 ? q.learn : c.queue === 0 ? q.nw : q.rev).unshift(c); }
    cur = Store.S.cards.get(rec.before.id) || rec.before; updCounts();
    showing = false; startedAt = Date.now(); await draw(false); bottom.innerHTML = '';
    bottom.append(h('button', { class: 'btn primary big wide', onclick: reveal }, 'Mostrar resposta'));
  }
  function finished() {
    frame.srcdoc = cardDoc('<h2>🎉 Parabéns!</h2><p>Você terminou este baralho por agora.</p>', '', darkMode());
    bottom.innerHTML = ''; bottom.append(h('button', { class: 'btn primary big wide', onclick: exit }, 'Voltar'));
  }
  function menu() {
    if (!cur) return;
    const act = fn => async () => { m.close(); await fn(); };
    const m = modal([h('div', { class: 'col' },
      h('button', { class: 'btn', onclick: act(undo) }, '↩ Desfazer última resposta'),
      h('button', { class: 'btn', onclick: act(async () => { const c = cur; await Store.setSuspended(c, true); cur = null; show(); }) }, '⏸ Suspender cartão'),
      h('button', { class: 'btn', onclick: act(async () => { const note = Store.S.notes.get(cur.nid); editNoteSheet(note, () => draw(showing)); }) }, '✎ Editar nota'),
      h('button', { class: 'btn', onclick: act(async () => { const s = Render.sounds((await draw(showing)).r.html); if (s[0]) playSound(s[0]); }) }, '🔊 Repetir áudio'),
      h('button', { class: 'btn danger', onclick: act(async () => { if (await confirmBox('Excluir esta nota e seus cartões?', 'Excluir', true)) { const id = cur.nid; await Store.deleteNote(id); q.learn = q.learn.filter(sibling(id)); q.rev = q.rev.filter(sibling(id)); q.nw = q.nw.filter(sibling(id)); cur = null; show(); } }) }, '🗑 Excluir nota'),
      h('button', { class: 'btn', onclick: () => m.close() }, 'Fechar'))]);
  }
  function handleKey(k) {
    if (document.querySelector('.overlay')) return;
    if (k === ' ' || k === 'Enter') { showing ? rate(3) : reveal(); }
    else if (showing && '1234'.includes(k) && k.length === 1) rate(+k);
    else if (k === 'z' || k === 'u') undo();
  }
  function onKey(e) {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === ' ' || e.key === 'Enter') e.preventDefault();
    handleKey(e.key);
  }
  document.addEventListener('keydown', onKey);
  show();
}

// Aba "Baralhos": resumo do dia, busca, filtros, árvore de baralhos e ações rápidas.
const collapsedKey = 'meuanki.collapsed', onlyDueKey = 'meuanki.onlyDue';
function getCollapsed() { try { return new Set(JSON.parse(localStorage.getItem(collapsedKey) || '[]')); } catch (e) { return new Set(); } }
function setCollapsed(set) { try { localStorage.setItem(collapsedKey, JSON.stringify([...set])); } catch (e) { /* ignore */ } }
function getOnlyDue() { try { return localStorage.getItem(onlyDueKey) === '1'; } catch (e) { return false; } }
function setOnlyDue(v) { try { localStorage.setItem(onlyDueKey, v ? '1' : '0'); } catch (e) { /* ignore */ } }
const normTxt = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
let deckQuery = '';

function rootsOf(decks) {
  const names = new Set(decks.map(d => d.name));
  return decks.filter(d => { const p = d.name.split('::'); for (let k = 1; k < p.length; k++) if (names.has(p.slice(0, k).join('::'))) return false; return true; });
}
const dueOf = (counts, d) => { const c = counts.get(d.id); return c ? c.new + c.learn + c.review : 0; };

function viewDecks(v) {
  const counts = Store.counts(), st = Store.deckStats(), all = Store.deckList();
  const decks = all.filter(d => !(d.name === 'Padrão' && all.length > 1 && (st.get(d.id)?.total || 0) === 0));
  const roots = rootsOf(decks);
  const hasKids = new Set(); for (const d of decks) { const p = d.name.split('::'); for (let k = 1; k < p.length; k++) hasKids.add(p.slice(0, k).join('::')); }

  // primeira vez com muitos baralhos: recolhe as subpastas
  try {
    if (localStorage.getItem(collapsedKey) === null && decks.length > 12) setCollapsed(new Set(decks.filter(d => d.name.includes('::') && hasKids.has(d.name)).map(d => d.name)));
  } catch (e) { /* ignore */ }

  v.append(h('header', { class: 'top' }, h('h1', null, 'Baralhos'), h('div', { class: 'row' },
    h('button', { class: 'btn small', onclick: doImport }, '⬇ Importar'),
    h('button', { class: 'btn small', onclick: async () => { const n = await promptBox('Novo baralho', '', 'Nome (use :: para subbaralhos)'); if (n) { await Store.createDeck(n); refresh(); } } }, '＋ Novo'))));

  if (Store.S.cards.size === 0) {
    v.append(h('div', { class: 'welcome' }, h('div', { class: 'wl-ic' }, '📚'), h('h2', null, 'Vamos começar?'),
      h('ol', null, h('li', null, 'No Anki do computador, exporte seu baralho em .apkg marcando “Suportar versões antigas do Anki”.'),
        h('li', null, 'Envie o arquivo para o iPhone (AirDrop, iCloud Drive ou e-mail).'),
        h('li', null, 'Toque em “Importar” aqui em cima e escolha o arquivo.')),
      h('button', { class: 'btn primary big wide', onclick: doImport }, '⬇ Importar baralho')));
    if (decks.length) v.append(h('div', { class: 'list' }, decks.map(d => h('div', { class: 'drow idle', onclick: () => deckSheet(d) }, h('div', { class: 'dline' }, h('div', { class: 'dtitle' }, d.name))))));
    return;
  }

  // ----- resumo de hoje -----
  let pend = 0; for (const r of roots) pend += dueOf(counts, r);
  const day = Store.ensureDay(); let done = 0; for (const k in day.new) done += day.new[k]; for (const k in day.rev) done += day.rev[k];
  const goal = Store.getPref('goal', 50), target = Math.max(1, Math.min(goal, done + pend));
  const pct = pend === 0 ? 100 : Math.min(100, Math.round(done * 100 / target));
  const go1 = () => {
    const last = Store.S.decks.get(Store.getPref('lastDeck', null));
    const target = last && dueOf(counts, last) > 0 ? last : roots.find(r => dueOf(counts, r) > 0);
    if (target) startStudy(target, 'normal');
  };
  v.append(h('div', { class: 'dhero' },
    h('div', { class: 'dh-l' },
      h('div', { class: 'dh-big' }, pend ? (pend > 999 ? '999+' : pend.toLocaleString('pt-BR')) : '🎉'),
      h('div', { class: 'dh-sub' }, pend ? (pend === 1 ? 'cartão para hoje' : pend > 999 ? 'cartões disponíveis hoje' : 'cartões para hoje') : 'Tudo em dia por hoje!'),
      h('div', { class: 'pbar' }, h('div', { style: `width:${pct}%` })),
      h('div', { class: 'dh-min' }, done ? `${done.toLocaleString('pt-BR')} de ${target.toLocaleString('pt-BR')} hoje · ${pct}%` : `Meta de hoje: ${target.toLocaleString('pt-BR')} cartões`)),
    pend ? h('button', { class: 'btn dh-btn', onclick: go1 }, '▶ Continuar') : null));

  // ----- busca e filtros -----
  const list = h('div', { class: 'list' });
  const q = h('input', { class: 'input', type: 'search', placeholder: '🔎 Buscar baralho…', value: deckQuery, autocapitalize: 'off', oninput: () => { deckQuery = q.value; renderList(); } });
  const chipDue = h('button', { class: 'chip2' + (getOnlyDue() ? ' on' : ''), onclick: () => { setOnlyDue(!getOnlyDue()); chipDue.classList.toggle('on', getOnlyDue()); renderList(); } }, 'Só com pendências');
  const chips = h('div', { class: 'chips' }, chipDue,
    h('button', { class: 'chip2', onclick: () => { setCollapsed(new Set([...hasKids])); renderList(); } }, '⊟ Recolher'),
    h('button', { class: 'chip2', onclick: () => { setCollapsed(new Set()); renderList(); } }, '⊞ Expandir'));
  v.append(q, chips, list);

  function renderList() {
    list.innerHTML = '';
    const collapsed = getCollapsed(), onlyDue = getOnlyDue(), search = normTxt(deckQuery.trim());
    let n = 0;
    for (const d of decks) {
      const parts = d.name.split('::');
      const c = counts.get(d.id) || { new: 0, learn: 0, review: 0 }, pending = c.new + c.learn + c.review, s = st.get(d.id) || { total: 0, mature: 0, young: 0, susp: 0 };
      if (search) { if (!normTxt(d.name).includes(search)) continue; }
      else { let hidden = false; for (let k = 1; k < parts.length; k++) if (collapsed.has(parts.slice(0, k).join('::'))) hidden = true; if (hidden) continue; }
      if (onlyDue && !pending) continue;
      const depth = search ? 0 : Math.min(parts.length - 1, 4), kids = hasKids.has(d.name) && !search;
      const active = Math.max(1, s.total - s.susp), pm = s.mature * 100 / active, py = s.young * 100 / active;
      n++;
      list.append(h('div', { class: `drow d${depth}` + (pending ? '' : ' idle'), onclick: () => deckSheet(d) },
        h('div', { class: 'dline', style: `padding-left:${depth * 14}px` },
          kids ? h('span', { class: 'tog', onclick: e => { e.stopPropagation(); const cs = getCollapsed(); cs.has(d.name) ? cs.delete(d.name) : cs.add(d.name); setCollapsed(cs); renderList(); } }, collapsed.has(d.name) ? '▸' : '▾') : h('span', { class: 'tog' }),
          h('div', { class: 'dtitle' }, search ? parts.join(' › ') : parts[parts.length - 1]),
          pending ? h('button', { class: 'play', 'aria-label': 'Estudar', onclick: e => { e.stopPropagation(); startStudy(d, 'normal'); } }, '▶') : null),
        h('div', { class: 'dmeta', style: `padding-left:${depth * 14 + 26}px` },
          h('span', { class: 'dsub' }, s.total ? `${s.total.toLocaleString('pt-BR')} cartões · ${Math.round(pm)}% dominado` : 'vazio'),
          h('span', { class: 'pills' }, c.new ? h('b', { class: 'pill n' }, c.new) : null, c.learn ? h('b', { class: 'pill l' }, c.learn) : null, c.review ? h('b', { class: 'pill r' }, c.review) : null,
            !pending && s.total ? h('b', { class: 'pill ok' }, '✓ em dia') : null)),
        s.total ? h('div', { class: 'mbar', style: `margin-left:${depth * 14 + 26}px` }, h('i', { class: 'c-mature', style: `width:${pm}%` }), h('i', { class: 'c-young', style: `width:${py}%` })) : null));
    }
    if (!n) list.append(h('div', { class: 'empty' }, search ? 'Nenhum baralho encontrado.' : 'Nada pendente por aqui 🎉'));
  }
  renderList();
}

function deckSheet(d) {
  const c = Store.counts().get(d.id) || { new: 0, learn: 0, review: 0 }, s = Store.deckStats().get(d.id) || { total: 0, mature: 0, young: 0, newC: 0, lrn: 0, susp: 0 };
  const parts = d.name.split('::');
  const mode = h('select', { class: 'input' }, [['normal', 'Revisão normal'], ['difficult', 'Cartões difíceis (mais erros)'], ['ahead', 'Revisar adiantado (7 dias)'], ['cram', 'Estudo livre (não altera agendamento)']].map(([v, l]) => h('option', { value: v }, l)));
  const hasSub = Store.deckList().some(x => x.name.startsWith(d.name + '::'));
  const m = modal([h('h3', null, parts[parts.length - 1]), parts.length > 1 ? h('div', { class: 'muted s path' }, parts.slice(0, -1).join(' › ')) : null,
    h('div', { class: 'bigcounts' }, h('div', { class: 'n' }, h('b', null, c.new), 'Novos'), h('div', { class: 'l' }, h('b', null, c.learn), 'Aprender'), h('div', { class: 'r' }, h('b', null, c.review), 'Revisar')),
    s.total ? stackBar({ total: s.total, suspended: s.susp, newC: s.newC, learning: s.lrn, young: s.young, mature: s.mature }) : null,
    s.total ? h('p', { class: 'muted' }, `${s.total.toLocaleString('pt-BR')} cartões · ${Math.round(s.mature * 100 / Math.max(1, s.total - s.susp))}% dominados`) : h('p', { class: 'muted' }, 'Baralho vazio. Adicione cartões na aba “Adicionar”.'),
    mode,
    hasSub ? h('label', { class: 'frow' }, h('span', null, 'Ordem aleatória', h('small', null, 'mistura os subbaralhos, alternando os assuntos')),
      h('input', { type: 'checkbox', checked: d.cfg.newRandom, onchange: async e => { d.cfg.newRandom = e.target.checked; await Store.saveDeck(d); } })) : null,
    h('div', { class: 'col' },
      h('button', { class: 'btn primary big', onclick: () => { m.close(); startStudy(d, mode.value); } }, 'Estudar agora'),
      h('div', { class: 'grid2' },
        h('button', { class: 'btn', onclick: () => { m.close(); deckOptions(d); } }, '⚙ Opções'),
        h('button', { class: 'btn', onclick: () => { m.close(); exportSheet(d); } }, '⬆ Exportar'),
        h('button', { class: 'btn', onclick: async () => { const n = await promptBox('Novo subbaralho dentro de “' + parts[parts.length - 1] + '”', '', 'Nome'); if (n) { m.close(); await Store.createDeck(d.name + '::' + n); const cs = getCollapsed(); cs.delete(d.name); setCollapsed(cs); refresh(); } } }, '＋ Subbaralho'),
        h('button', { class: 'btn', onclick: async () => { const n = await promptBox('Renomear baralho', d.name); if (n && n !== d.name) { m.close(); await Store.renameDeck(d, n); refresh(); } } }, '✎ Renomear'),
        h('button', { class: 'btn danger', onclick: async () => { if (await confirmBox(`Excluir "${d.name}" e todos os seus cartões? Isso não pode ser desfeito.`, 'Excluir', true)) { m.close(); await Store.deleteDeck(d); refresh(); } } }, '🗑 Excluir')),
      h('button', { class: 'btn', onclick: () => m.close() }, 'Fechar'))]);
}

// Interface: navegador, adicionar, estatísticas, ajustes e opções do baralho.

// ---------- Editor de campos (usado em Adicionar e Editar) ----------
const toEdit = s => String(s || '').replace(/<br\s*\/?>/gi, '\n');
const fromEdit = s => s.replace(/\r?\n/g, '<br>');

function fieldEditor(model, values = []) {
  const areas = model.flds.map((name, i) => h('textarea', { class: 'input ta', rows: 3, placeholder: name }, toEdit(values[i] || '')));
  let active = areas[0];
  areas.forEach(a => a.addEventListener('focus', () => { active = a; }));
  const wrapSel = (open, close) => {
    const a = active, s = a.selectionStart, e = a.selectionEnd;
    a.setRangeText(open + a.value.slice(s, e) + close, s, e, 'end'); a.focus();
  };
  const insert = t => { const a = active; a.setRangeText(t, a.selectionStart, a.selectionEnd, 'end'); a.focus(); };
  const nextCloze = () => Math.max(0, ...Render.clozeOrds(areas[0].value)) + 1;
  const attach = async () => {
    const [f] = await pickFiles(false); if (!f) return;
    const base = f.name.replace(/[^\w.\-]+/g, '_'), name = Date.now().toString(36) + '_' + base;
    await Store.putMedia(name, f);
    insert(f.type.startsWith('audio') ? `[sound:${name}]` : `<img src="${name}">`);
  };
  const bar = h('div', { class: 'row wrap fmt' },
    h('button', { class: 'btn small', onclick: () => wrapSel('<b>', '</b>') }, h('b', null, 'B')),
    h('button', { class: 'btn small', onclick: () => wrapSel('<i>', '</i>') }, h('i', null, 'I')),
    h('button', { class: 'btn small', onclick: () => wrapSel('<u>', '</u>') }, h('u', null, 'U')),
    model.isCloze ? h('button', { class: 'btn small', onclick: () => wrapSel(`{{c${nextCloze()}::`, '}}') }, '[…] Omitir') : null,
    h('button', { class: 'btn small', onclick: attach }, '📎 Mídia'));
  const el = h('div', { class: 'col' }, bar, model.flds.map((n, i) => h('label', { class: 'lbl' }, n, areas[i])));
  return { el, get: () => areas.map(a => fromEdit(a.value)), clear: () => { areas.forEach(a => { a.value = ''; }); areas[0].focus(); } };
}

// ---------- Editar nota ----------
function editNoteSheet(note, onSaved) {
  const model = Store.S.models.get(note.mid);
  const fe = fieldEditor(model, note.flds);
  const tags = h('input', { class: 'input', type: 'text', value: note.tags, placeholder: 'tags separadas por espaço', autocapitalize: 'off' });
  const m = modal([h('h3', null, 'Editar nota · ' + model.name), fe.el, h('label', { class: 'lbl' }, 'Tags', tags),
    h('div', { class: 'row end' }, h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'),
      h('button', { class: 'btn primary', onclick: async () => { await Store.updateNote(note, fe.get(), tags.value); m.close(); onSaved && onSaved(); } }, 'Salvar'))], { full: true });
}

// ---------- Navegar ----------
function viewBrowse(v) {
  const q = h('input', { class: 'input', type: 'search', placeholder: 'texto  tag:x  deck:x  is:new  is:due  is:suspended  is:leech', autocapitalize: 'off', value: window.__q || '' });
  const info = h('div', { class: 'muted' }); const list = h('div', { class: 'list' });
  const run = () => {
    window.__q = q.value; list.innerHTML = '';
    const rows = Store.search(q.value);
    info.textContent = rows.length + (rows.length >= 300 ? '+' : '') + ' cartões';
    const t = Sched.today();
    for (const [c, n] of rows) {
      const model = Store.S.models.get(n.mid);
      const chips = [];
      if (c.queue === -1) chips.push(h('span', { class: 'chip warn' }, 'suspenso'));
      if (/\bleech\b/.test(n.tags)) chips.push(h('span', { class: 'chip bad' }, 'sanguessuga'));
      if (c.queue === 0) chips.push(h('span', { class: 'chip' }, 'novo'));
      else if (c.queue === 2) chips.push(h('span', { class: 'chip' }, c.due <= t ? 'vence hoje' : 'em ' + Sched.fmtDays(c.due - t)));
      list.append(h('div', { class: 'brow', onclick: () => rowSheet(c, n, run) },
        h('div', { class: 'b1' }, Render.stripHTML(model.isCloze ? Render.clozeText(n.flds[0] || '', c.ord + 1, true) : n.flds[0] || '') || '(vazio)'),
        h('div', { class: 'b2' }, Render.stripHTML(n.flds[1] || '')),
        h('div', { class: 'row wrap' }, h('span', { class: 'muted s' }, Store.S.decks.get(c.did)?.name), chips)));
    }
  };
  let tm; q.addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(run, 250); });
  v.append(h('header', { class: 'top' }, h('h1', null, 'Navegar')), q, info, list); run();
}
function rowSheet(c, n, done) {
  const m = modal([h('h3', null, 'Cartão'), h('div', { class: 'col' },
    h('button', { class: 'btn', onclick: () => { m.close(); editNoteSheet(n, done); } }, '✎ Editar nota'),
    h('button', { class: 'btn', onclick: async () => { m.close(); await Store.setSuspended(c, c.queue !== -1); done(); } }, c.queue === -1 ? '▶ Reativar cartão' : '⏸ Suspender cartão'),
    h('button', { class: 'btn', onclick: async () => { m.close(); await Store.resetCard(c); done(); toast('Cartão zerado (novo)'); } }, '↺ Zerar progresso'),
    h('button', { class: 'btn', onclick: () => { m.close(); moveSheet(c, done); } }, '📁 Mover para outro baralho'),
    h('button', { class: 'btn danger', onclick: async () => { if (await confirmBox('Excluir esta nota?', 'Excluir', true)) { m.close(); await Store.deleteNote(n.id); done(); } } }, '🗑 Excluir nota'),
    h('button', { class: 'btn', onclick: () => m.close() }, 'Fechar'))]);
}
function moveSheet(c, done) {
  const sel = h('select', { class: 'input' }, Store.deckList().map(d => h('option', { value: d.id }, d.name)));
  sel.value = c.did;
  const m = modal([h('h3', null, 'Mover para'), sel, h('div', { class: 'row end' }, h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'),
    h('button', { class: 'btn primary', onclick: async () => { await Store.moveCards([c], +sel.value); m.close(); done(); } }, 'Mover'))]);
}

// ---------- Adicionar ----------
let addState = { mid: null, did: null };
function viewAdd(v) {
  const models = [...Store.S.models.values()], decks = Store.deckList();
  if (!models.some(m => m.id === addState.mid)) addState.mid = models[0].id;
  if (!decks.some(d => d.id === addState.did)) addState.did = decks[0].id;
  const ms = h('select', { class: 'input', onchange: () => { addState.mid = +ms.value; go('add'); } }, models.map(m => h('option', { value: m.id }, m.name)));
  ms.value = addState.mid;
  const ds = h('select', { class: 'input', onchange: () => { addState.did = +ds.value; } }, decks.map(d => h('option', { value: d.id }, d.name)));
  ds.value = addState.did;
  const model = Store.S.models.get(addState.mid), fe = fieldEditor(model);
  const tags = h('input', { class: 'input', type: 'text', placeholder: 'tags separadas por espaço', autocapitalize: 'off' });
  v.append(h('header', { class: 'top' }, h('h1', null, 'Adicionar')),
    h('div', { class: 'col' }, h('label', { class: 'lbl' }, 'Tipo de nota', ms), h('label', { class: 'lbl' }, 'Baralho', ds), fe.el, h('label', { class: 'lbl' }, 'Tags', tags),
      model.isCloze ? h('p', { class: 'muted' }, 'Selecione um trecho e toque em “Omitir”, ou escreva {{c1::resposta}}.') : null,
      h('button', { class: 'btn primary big', onclick: async () => {
        const f = fe.get(); if (!f[0].trim()) { toast('Preencha o primeiro campo'); return; }
        const n = await Store.addNote(model, addState.did, f, tags.value);
        if (n) { toast(`✓ ${n} cartão(ões) criado(s)`); fe.clear(); } else alertBox('Nenhum cartão foi gerado. Verifique os campos' + (model.isCloze ? ' e as omissões {{c1::…}}.' : '.'));
      } }, 'Adicionar')));
}

// ---------- Estatísticas ----------
function barChart(vals, labels, color) {
  const W = 320, H = 110, max = Math.max(1, ...vals), bw = W / vals.length;
  const bars = vals.map((x, i) => { const bh = Math.round(x / max * (H - 30)); return `<rect x="${i * bw + 1}" y="${H - 14 - bh}" width="${Math.max(1, bw - 2)}" height="${bh}" rx="2" fill="${color}"/>`; }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="chart"><text x="${W}" y="10" font-size="10" text-anchor="end" fill="currentColor" opacity=".6">máx ${max}</text>${bars}<text x="0" y="${H - 2}" font-size="10" fill="currentColor" opacity=".6">${labels[0]}</text><text x="${W}" y="${H - 2}" font-size="10" text-anchor="end" fill="currentColor" opacity=".6">${labels[1]}</text></svg>`;
}
// ---------- Mais ----------
async function viewMore(v) {
  let usage = '';
  try { const e = await navigator.storage.estimate(); usage = `Armazenamento usado: ${(e.usage / 1048576).toFixed(1)} MB` + (e.quota ? ` de ${(e.quota / 1048576).toFixed(0)} MB` : ''); } catch (e) { /* ignore */ }
  let persisted = false; try { persisted = await navigator.storage.persisted(); } catch (e) { /* ignore */ }
  const standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  v.append(h('header', { class: 'top' }, h('h1', null, 'Mais')),
    installCard(),
    h('div', { class: 'card2' }, h('h3', null, 'Backup'),
      h('p', { class: 'muted' }, 'Os dados ficam só neste aparelho. Faça backup de tempos em tempos (e antes de limpar dados do Safari).'),
      h('div', { class: 'col' },
        h('button', { class: 'btn primary', onclick: async () => { const b = busy('Gerando backup…'); try { const r = await Apkg.backup(t => b.set(t)); b.close(); saveFileDialog(r.blob, r.name); } catch (e) { b.close(); alertBox(e.message); } } }, '⬆ Criar backup completo'),
        h('button', { class: 'btn', onclick: async () => {
          const [f] = await pickFiles(false); if (!f) return;
          if (!await confirmBox('Restaurar substitui TODOS os dados atuais pelo conteúdo do backup. Continuar?', 'Restaurar', true)) return;
          const b = busy('Restaurando…'); try { const r = await Apkg.restore(f, t => b.set(t)); b.close(); await alertBox(`Restaurado: ${r.notes} notas, ${r.cards} cartões, ${r.media} arquivos de mídia.`); go('decks'); } catch (e) { b.close(); alertBox('Erro: ' + e.message); }
        } }, '⬇ Restaurar backup'))),
    h('div', { class: 'card2' }, h('h3', null, 'Status'),
      h('p', { class: 'muted pre' }, [usage, persisted ? 'Armazenamento persistente: sim' : 'Armazenamento persistente: não garantido', standalone ? 'Instalado na tela inicial: sim' : 'Instalado na tela inicial: não', 'Funciona offline após o primeiro carregamento.'].filter(Boolean).join('\n'))),
    h('div', { class: 'card2' }, h('h3', null, 'Zona de perigo'),
      h('button', { class: 'btn danger', onclick: async () => { if (await confirmBox('Apagar TODOS os baralhos, cartões e mídia deste aparelho?', 'Apagar tudo', true)) { await Store.resetAll(); go('decks'); } } }, '🗑 Apagar todos os dados')),
    h('p', { class: 'muted center' }, 'Recly · app web offline compatível com .apkg'));
}

// ---------- Opções do baralho ----------
function deckOptions(d) {
  const c = { ...d.cfg, learnSteps: [...d.cfg.learnSteps], lapseSteps: [...d.cfg.lapseSteps] };
  const num = (key, label, step = 1, min = 0, hint = '') => h('label', { class: 'frow' }, h('span', null, label, hint ? h('small', null, hint) : null),
    h('input', { class: 'input num', type: 'number', inputmode: 'decimal', step, min, value: c[key], onchange: e => { c[key] = parseFloat(e.target.value.replace(',', '.')); } }));
  const steps = (key, label) => h('label', { class: 'frow' }, h('span', null, label, h('small', null, 'minutos, separados por espaço')),
    h('input', { class: 'input num', type: 'text', value: c[key].join(' '), onchange: e => { c[key] = e.target.value.split(/[\s,]+/).map(x => parseFloat(x)).filter(x => x > 0); } }));
  const chk = (key, label) => h('label', { class: 'frow' }, h('span', null, label), h('input', { type: 'checkbox', checked: c[key], onchange: e => { c[key] = e.target.checked; } }));
  const m = modal([h('h3', null, 'Opções · ' + d.name),
    h('h4', null, 'Limites diários'), num('newPerDay', 'Novos cartões/dia'), num('revPerDay', 'Revisões máx./dia'),
    h('h4', null, 'Novos cartões'), steps('learnSteps', 'Passos de aprendizado'), num('gradIvl', 'Intervalo de graduação (dias)'), num('easyIvl', 'Intervalo fácil (dias)'), num('startEase', 'Facilidade inicial', 50, 1300, '2500 = 250%'), chk('newRandom', 'Ordem aleatória'), chk('burySiblings', 'Enterrar cartões irmãos'),
    h('h4', null, 'Revisões'), num('easyBonus', 'Bônus fácil', 0.05, 1), num('ivlMod', 'Modificador de intervalo', 0.05, 0.1), num('hardMod', 'Intervalo difícil', 0.05, 0.5), num('maxIvl', 'Intervalo máximo (dias)'),
    h('h4', null, 'Lapsos'), steps('lapseSteps', 'Passos de reaprendizado'), num('newIvlMod', 'Novo intervalo', 0.05, 0, '0 = recomeçar'), num('minLapseIvl', 'Intervalo mínimo (dias)'), num('leechThreshold', 'Limite de sanguessuga (erros)'),
    h('h4', null, 'Áudio'), chk('autoAudio', 'Tocar áudio automaticamente'),
    h('div', { class: 'row end sticky' }, h('button', { class: 'btn', onclick: () => m.close() }, 'Cancelar'),
      h('button', { class: 'btn', onclick: async () => { if (await confirmBox('Aplicar estas opções a todos os subbaralhos também?', 'Aplicar')) { for (const x of Store.deckList()) if (Store.inTree(x, d)) { x.cfg = { ...c, learnSteps: [...c.learnSteps], lapseSteps: [...c.lapseSteps] }; await Store.saveDeck(x); } m.close(); refresh(); } } }, 'Salvar em todos'),
      h('button', { class: 'btn primary', onclick: async () => { d.cfg = c; await Store.saveDeck(d); m.close(); refresh(); toast('Opções salvas'); } }, 'Salvar'))], { full: true });
}

// Aba "Progresso": sequência, meta diária, calendário de atividade e cartão para compartilhar.
const WD = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const MILESTONES = [[365, '👑', '1 ano seguido'], [200, '💎', '200 dias seguidos'], [100, '🏆', '100 dias seguidos'], [60, '🥇', '2 meses seguidos'],
  [30, '🏅', '1 mês seguido'], [14, '⭐', '2 semanas seguidas'], [7, '🌟', '1 semana seguida'], [3, '✨', '3 dias seguidos']];
const PALETTES = [['#6366f1', '#8b5cf6', '#ec4899'], ['#0ea5e9', '#10b981', '#eab308'], ['#0f172a', '#4c1d95', '#be185d'], ['#f97316', '#ef4444', '#a21caf']];
const fmtTime = ms => { const m = Math.round(ms / 60000); return m < 60 ? m + ' min' : Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0'); };
const dowOf = day => (day + 4) % 7; // 0 = domingo (1/1/1970 foi quinta)
const dayLevel = (n, goal) => n <= 0 ? 0 : n < goal * 0.25 ? 1 : n < goal * 0.5 ? 2 : n < goal ? 3 : 4;
function milestone(streak) { return MILESTONES.find(m => streak >= m[0]) || null; }
function greeting() { const hr = new Date().getHours(); return hr < 12 ? 'Bom dia' : hr < 18 ? 'Boa tarde' : 'Boa noite'; }

function encourage(s, goal) {
  const n = s.today.n;
  if (s.total === 0) return 'Importe um baralho e comece sua jornada 🌱';
  if (n >= goal) return 'Meta do dia batida! Você está de parabéns 🎉';
  if (n > 0) return `Faltam ${goal - n} cartões para a meta. Você consegue! 💪`;
  if (s.streak > 0) return `Estude hoje para manter sua sequência de ${s.streak} ${s.streak === 1 ? 'dia' : 'dias'} 🔥`;
  return 'Comece com um cartão só — cada passo conta 🌱';
}

function ringSVG(pct, big, small) {
  const r = 48, c = 2 * Math.PI * r, p = Math.max(0, Math.min(1, pct));
  return `<svg viewBox="0 0 120 120" class="ring"><circle cx="60" cy="60" r="${r}" fill="none" stroke="rgba(255,255,255,.28)" stroke-width="11"/>` +
    `<circle cx="60" cy="60" r="${r}" fill="none" stroke="#fff" stroke-width="11" stroke-linecap="round" stroke-dasharray="${(c * p).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 60 60)"/>` +
    `<text x="60" y="64" text-anchor="middle" font-size="28" font-weight="800" fill="#fff">${big}</text>` +
    `<text x="60" y="84" text-anchor="middle" font-size="11" fill="#fff" opacity=".85">${small}</text></svg>`;
}

function weekStrip(s) {
  const t = s.todayDay, cells = [];
  for (let i = 6; i >= 0; i--) {
    const d = t - i, done = s.per.has(d);
    cells.push(h('div', { class: 'wd' + (d === t ? ' today' : '') }, h('div', { class: 'dot' + (done ? ' on' : '') }, done ? '✓' : ''), h('span', null, WD[dowOf(d)])));
  }
  return h('div', { class: 'week' }, cells);
}

function heatmap(s, goal) {
  const weeks = 12, t = s.todayDay, startOfThisWeek = t - dowOf(t), first = startOfThisWeek - (weeks - 1) * 7;
  const grid = h('div', { class: 'heat' });
  let active = 0;
  for (let w = 0; w < weeks; w++) for (let r = 0; r < 7; r++) {
    const d = first + w * 7 + r;
    if (d > t) { grid.append(h('i', { class: 'hc fut' })); continue; }
    const n = (s.per.get(d) || { n: 0 }).n; if (n > 0) active++;
    const date = new Date(d * 86400000 + 12 * 3600000);
    grid.append(h('i', { class: 'hc l' + dayLevel(n, goal), title: `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}: ${n} cartões` }));
  }
  return { el: grid, active };
}

function stackBar(s) {
  const tot = Math.max(1, s.total - s.suspended);
  const parts = [['Novos', s.newC, 'c-new'], ['Aprendendo', s.learning, 'c-lrn'], ['Jovens', s.young, 'c-young'], ['Dominados', s.mature, 'c-mature']];
  return h('div', null,
    h('div', { class: 'stack' }, parts.map(([, n, c]) => n ? h('div', { class: c, style: `flex:${n}` }) : null)),
    h('div', { class: 'legend2' }, parts.map(([l, n, c]) => h('span', null, h('i', { class: 'sw ' + c }), `${l} ${n}`))));
}

async function viewStats(v) {
  const s = await Store.stats();
  if (currentTab !== 'stats') return;
  const goal = Store.getPref('goal', 50);
  const n = s.today.n, pct = n / goal, ms = milestone(s.streak);
  const hm = heatmap(s, goal);

  v.append(h('header', { class: 'top' }, h('div', null, h('h1', null, 'Seu progresso'), h('div', { class: 'muted' }, `${greeting()}! ${encourage(s, goal)}`))));

  // Cartão principal
  v.append(h('div', { class: 'hero' },
    h('div', { class: 'hero-l' },
      h('div', { class: 'flame' }, s.streak > 0 ? '🔥' : '🌱'),
      h('div', { class: 'streak' }, s.streak),
      h('div', { class: 'streak-l' }, s.streak === 1 ? 'dia seguido' : 'dias seguidos'),
      h('div', { class: 'best' }, `Recorde: ${s.best} ${s.best === 1 ? 'dia' : 'dias'}`),
      ms ? h('div', { class: 'badge2' }, `${ms[1]} ${ms[2]}`) : null),
    h('div', { class: 'hero-r', onclick: async () => { const x = await promptBox('Meta diária (cartões por dia)', String(goal), 'ex.: 50'); const g = parseInt(x, 10); if (g > 0) { await Store.setPref('goal', g); go('stats'); } } },
      h('div', { html: ringSVG(pct, n, `de ${goal} hoje`) }), h('div', { class: 'goal-edit' }, 'Meta ✎'))));

  v.append(h('div', { class: 'card2' }, h('div', { class: 'row between' }, h('h3', null, 'Últimos 7 dias'), h('span', { class: 'muted' }, `${[...Array(7).keys()].filter(i => s.per.has(s.todayDay - i)).length}/7 dias`)), weekStrip(s)));

  const hmCard = h('div', { class: 'card2' }, h('div', { class: 'row between' }, h('h3', null, 'Constância'), h('span', { class: 'muted' }, `${hm.active} dias em 12 semanas`)),
    h('div', { class: 'heatwrap' }, h('div', { class: 'heatdays' }, ['D', '', 'T', '', 'Q', '', 'S'].map(x => h('span', null, x))), hm.el),
    h('div', { class: 'heatlegend' }, 'menos ', [0, 1, 2, 3, 4].map(l => h('i', { class: 'hc l' + l })), ' mais'));
  v.append(hmCard);

  v.append(h('div', { class: 'card2' }, h('h3', null, 'Seus cartões'), stackBar(s),
    h('p', { class: 'muted' }, s.total ? `${Math.round(s.mature * 100 / Math.max(1, s.total - s.suspended))}% já dominados (intervalo de 21 dias ou mais)` : 'Nenhum cartão ainda.')));

  const avg = s.activeDays ? Math.round(s.totalReviews / s.activeDays) : 0;
  const tile = (ic, big, label) => h('div', { class: 'tile' }, h('div', { class: 'tic' }, ic), h('div', { class: 'tbig' }, big), h('div', { class: 'tlab' }, label));
  v.append(h('div', { class: 'tiles' },
    tile('✅', s.totalReviews.toLocaleString('pt-BR'), 'revisões no total'), tile('⏱️', fmtTime(s.totalMs), 'de estudo'),
    tile('🎯', s.retention == null ? '—' : s.retention + '%', 'de acerto (30 dias)'), tile('📆', avg.toLocaleString('pt-BR'), 'cartões por dia de estudo')));

  v.append(h('div', { class: 'card2' }, h('h3', null, 'Próximos 14 dias'), h('div', { html: barChart(s.forecast, ['hoje', '+14d'], '#8b5cf6') }), h('p', { class: 'muted' }, 'Revisões previstas por dia')));

  v.append(h('button', { class: 'btn primary big wide share', onclick: () => shareCard(s, goal) }, '📸 Compartilhar meu progresso'),
    h('p', { class: 'muted center' }, 'Gera uma imagem bonita para postar. Nenhum dado seu é enviado a lugar nenhum.'));
}

// ---------- Imagens para compartilhar (1080×1350, retrato do Instagram) ----------
const MONTHS_FULL = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const WEEKDAYS_FULL = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
const SHARE_KINDS = [['streak', '🔥 Sequência'], ['today', '☀️ Hoje'], ['week', '📅 Semana'], ['month', '🗓️ Mês'], ['total', '🏆 Total']];
const SF = '-apple-system, "SF Pro Display", "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

function rr(ctx, x, y, w, h2, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h2, r); ctx.arcTo(x + w, y + h2, x, y + h2, r); ctx.arcTo(x, y + h2, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
const W = 1080, H = 1350;
let phraseSeed = 0;
const pick = (arr, salt = 0) => arr[(phraseSeed + salt) % arr.length];
const PH = {
  goalHit: ['Meta batida! 🎉', 'Meta cumprida! 🚀', 'Missão dada, missão cumprida! 🎯', 'Dia ganho! 🏆', 'Meta de hoje no bolso! ✅'],
  zero: ['Ainda dá tempo! 🌱', 'Hoje ainda é dia de estudar 📚', 'Comece com um cartão 🚀', 'O primeiro cartão é o mais difícil 🎯'],
  day: ['Um pouco todo dia 🚀', 'Foco no objetivo 🎯', 'Cada cartão conta 📚', 'Rumo à aprovação 🚀', 'Constância é o segredo 🔑', 'Estudar hoje, colher amanhã 🌱', 'Mais um passo rumo ao alvo 🎯', 'Passo a passo, chegamos lá 🏁', 'Disciplina vence talento ⭐', 'Mais um dia de evolução 📈'],
  weekPerfect: ['Semana perfeita! 🏆', '7 de 7! Imparável 🚀', 'Semana impecável 🏅', 'Nenhum dia ficou para trás 🎯'],
  week: ['Constância vence 🚀', 'Cada dia conta 📚', 'Seguimos firmes 🎯', 'Semana de evolução 📈', 'Foco e disciplina 🔥', 'Um dia de cada vez 🌱', 'Rumo à aprovação 🏁'],
};
function text(ctx, str, x, y, size, weight = 700, alpha = 1, align = 'center') {
  ctx.textAlign = align; ctx.globalAlpha = alpha; ctx.font = `${weight} ${size}px ${SF}`; ctx.fillStyle = '#fff'; ctx.fillText(str, x, y); ctx.globalAlpha = 1;
}
function shareBase(ctx, pal, right) {
  const g = ctx.createLinearGradient(0, 0, W, H); g.addColorStop(0, pal[0]); g.addColorStop(0.55, pal[1]); g.addColorStop(1, pal[2]);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(255,255,255,.08)'; ctx.beginPath(); ctx.arc(900, 180, 330, 0, 7); ctx.fill(); ctx.beginPath(); ctx.arc(120, 1180, 380, 0, 7); ctx.fill();
  text(ctx, '📚 Recly', 80, 130, 46, 700, 1, 'left'); text(ctx, right, W - 80, 130, 40, 500, 0.85, 'right');
}
function tilesRow(ctx, items, y, h2 = 190) {
  const n = items.length, gap = 22, w = (W - 160 - gap * (n - 1)) / n;
  items.forEach(([big, lab], i) => {
    const x = 80 + i * (w + gap);
    ctx.fillStyle = 'rgba(255,255,255,.18)'; rr(ctx, x, y, w, h2, 36); ctx.fill();
    text(ctx, big, x + w / 2, y + h2 * 0.53, big.length > 6 ? 62 : 78, 800); text(ctx, lab, x + w / 2, y + h2 * 0.8, 34, 500, 0.85);
  });
}
function agg(s, days) {
  let n = 0, ms = 0, ok = 0, active = 0;
  for (const d of days) { const e = s.per.get(d); if (e) { n += e.n; ms += e.ms; ok += e.ok || 0; if (e.n) active++; } }
  return { n, ms, active, acc: n ? Math.round(ok * 100 / n) : null };
}
const pctTxt = v => v == null ? '—' : v + '%';
const dayFromDate = (y, m, d) => Sched.dayOf(new Date(y, m, d, 12).getTime() / 1000);
const footer = (ctx, str) => text(ctx, str, W / 2, 1300, 38, 600, 0.9);

function drawStreak(ctx, s, goal, pal) {
  const d = new Date(); shareBase(ctx, pal, `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`);
  const has = s.streak > 0;
  text(ctx, has ? '🔥' : '🌱', W / 2, 430, 210, 400);
  text(ctx, String(has ? s.streak : s.totalReviews), W / 2, 720, 330, 800);
  text(ctx, has ? (s.streak === 1 ? 'dia seguido estudando' : 'dias seguidos estudando') : 'cartões revisados', W / 2, 805, 66, 600);
  const ms = milestone(s.streak);
  if (ms) { const label = `${ms[1]} ${ms[2]}`; ctx.font = `700 44px ${SF}`; const tw = ctx.measureText(label).width + 70; ctx.fillStyle = 'rgba(255,255,255,.2)'; rr(ctx, W / 2 - tw / 2, 835, tw, 76, 38); ctx.fill(); text(ctx, label, W / 2, 889, 44); }
  tilesRow(ctx, [[String(s.today.n), 'hoje'], [s.totalReviews.toLocaleString('pt-BR'), 'revisões'], [pctTxt(s.retention), 'de acerto']], 960);
  for (let i = 6; i >= 0; i--) {
    const day = s.todayDay - i, x = 150 + (6 - i) * 130, done = s.per.has(day);
    ctx.beginPath(); ctx.arc(x, 1235, 38, 0, 7);
    if (done) { ctx.fillStyle = '#fff'; ctx.fill(); ctx.fillStyle = pal[1]; ctx.font = `800 44px ${SF}`; ctx.textAlign = 'center'; ctx.fillText('✓', x, 1250); }
    else { ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 5; ctx.stroke(); }
    text(ctx, WD[dowOf(day)], x, 1305, 30, 600, 0.85);
  }
}

function drawToday(ctx, s, goal, pal) {
  const d = new Date(); shareBase(ctx, pal, `${d.getDate()} ${MONTHS[d.getMonth()]}`);
  const t = agg(s, [s.todayDay]), n = t.n;
  text(ctx, 'Meu dia de estudo', W / 2, 270, 60, 700);
  text(ctx, WEEKDAYS_FULL[d.getDay()], W / 2, 335, 40, 500, 0.85);
  const cx = W / 2, cy = 640, r = 235;
  ctx.lineCap = 'round'; ctx.lineWidth = 48; ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.stroke();
  const p = Math.min(1, n / goal);
  if (p > 0) { ctx.strokeStyle = '#fff'; ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p); ctx.stroke(); }
  text(ctx, String(n), cx, cy + 50, n > 999 ? 140 : 190, 800); text(ctx, `de ${goal} cartões`, cx, cy + 125, 44, 500, 0.9);
  const left = goal - n, msg = n >= goal ? pick(PH.goalHit) : n > 0 ? pick([`Faltam ${left} para a meta 🎯`, `Só mais ${left} para bater a meta 🚀`, `Falta pouco: ${left} cartões 📚`, `Bora! Faltam ${left} 💪`]) : pick(PH.zero);
  text(ctx, msg, W / 2, 985, 62, 800);
  tilesRow(ctx, [[fmtTime(t.ms), 'de estudo'], [pctTxt(t.acc), 'de acerto'], [s.streak ? `🔥 ${s.streak}` : '—', s.streak === 1 ? 'dia seguido' : 'dias seguidos']], 1040);
  footer(ctx, pick(PH.day, 3));
}

function drawWeek(ctx, s, goal, pal) {
  shareBase(ctx, pal, 'Últimos 7 dias');
  const days = [...Array(7).keys()].map(i => s.todayDay - 6 + i), a = agg(s, days);
  text(ctx, 'Minha semana', W / 2, 270, 60, 700);
  text(ctx, a.n.toLocaleString('pt-BR'), W / 2, 500, 230, 800); text(ctx, a.n === 1 ? 'cartão revisado' : 'cartões revisados', W / 2, 575, 56, 600);
  const vals = days.map(d => (s.per.get(d) || { n: 0 }).n), max = Math.max(1, ...vals), base = 960, hMax = 300, bw = 100, gap = 28, x0 = (W - (7 * bw + 6 * gap)) / 2;
  vals.forEach((v, i) => {
    const x = x0 + i * (bw + gap), bh = v ? Math.max(18, Math.round(v / max * hMax)) : 10, isT = i === 6;
    ctx.fillStyle = isT ? '#fff' : v ? 'rgba(255,255,255,.6)' : 'rgba(255,255,255,.22)'; rr(ctx, x, base - bh, bw, bh, 22); ctx.fill();
    if (v) text(ctx, String(v), x + bw / 2, base - bh - 16, 32, 700, 0.95);
    text(ctx, WD[dowOf(days[i])], x + bw / 2, base + 52, 36, isT ? 800 : 600, isT ? 1 : 0.8);
  });
  tilesRow(ctx, [[`${a.active}/7`, 'dias estudados'], [fmtTime(a.ms), 'de estudo'], [pctTxt(a.acc), 'de acerto']], 1045);
  footer(ctx, a.active >= 7 ? pick(PH.weekPerfect) : pick(PH.week));
}

function drawMonth(ctx, s, goal, pal) {
  const now = new Date(), y = now.getFullYear(), mo = now.getMonth();
  shareBase(ctx, pal, String(y));
  const dim = new Date(y, mo + 1, 0).getDate(), offset = new Date(y, mo, 1).getDay();
  const days = [...Array(dim).keys()].map(i => dayFromDate(y, mo, i + 1)), a = agg(s, days);
  text(ctx, MONTHS_FULL[mo], W / 2, 270, 70, 800);
  text(ctx, a.n.toLocaleString('pt-BR'), W / 2, 440, 150, 800); text(ctx, a.n === 1 ? 'cartão neste mês' : 'cartões neste mês', W / 2, 500, 44, 600, 0.9);
  const cw = (W - 160) / 7, top = 650;
  WD.forEach((l, i) => text(ctx, l, 80 + cw * i + cw / 2, 590, 34, 600, 0.75));
  days.forEach((dayNum, i) => {
    const pos = offset + i, col = pos % 7, row = Math.floor(pos / 7), cx = 80 + cw * col + cw / 2, cy = top + row * 98 + 40, isT = dayNum === s.todayDay, future = dayNum > s.todayDay, done = s.per.has(dayNum);
    ctx.beginPath(); ctx.arc(cx, cy, 38, 0, 7);
    if (done) { ctx.fillStyle = '#fff'; ctx.fill(); ctx.fillStyle = pal[1]; ctx.font = `800 36px ${SF}`; ctx.textAlign = 'center'; ctx.fillText(String(i + 1), cx, cy + 13); }
    else { ctx.lineWidth = isT ? 6 : 3; ctx.strokeStyle = isT ? '#fff' : 'rgba(255,255,255,.3)'; ctx.stroke(); text(ctx, String(i + 1), cx, cy + 13, 34, 600, future ? 0.35 : 0.75); }
  });
  const elapsed = days.filter(d => d <= s.todayDay).length;
  text(ctx, `${a.active} de ${elapsed} dias estudados · ${fmtTime(a.ms)}`, W / 2, 1300, 40, 700, 0.95);
}

function drawTotal(ctx, s, goal, pal) {
  const d = new Date(); shareBase(ctx, pal, `${MONTHS[d.getMonth()]} ${d.getFullYear()}`);
  text(ctx, 'Minha jornada', W / 2, 270, 60, 700);
  text(ctx, s.totalReviews.toLocaleString('pt-BR'), W / 2, 520, s.totalReviews > 99999 ? 190 : 240, 800); text(ctx, 'cartões revisados', W / 2, 600, 56, 600);
  const act = Math.max(1, s.total - s.suspended), mpct = s.total ? Math.round(s.mature * 100 / act) : 0;
  tilesRow(ctx, [[String(s.activeDays), 'dias estudados'], [fmtTime(s.totalMs), 'de estudo']], 690, 200);
  tilesRow(ctx, [[`🔥 ${s.best}`, 'maior sequência'], [pctTxt(s.retention), 'de acerto (30d)']], 930, 200);
  ctx.fillStyle = 'rgba(255,255,255,.25)'; rr(ctx, 80, 1190, W - 160, 36, 18); ctx.fill();
  if (mpct > 0) { ctx.fillStyle = '#fff'; rr(ctx, 80, 1190, Math.max(36, (W - 160) * mpct / 100), 36, 18); ctx.fill(); }
  text(ctx, `${mpct}% dos cartões dominados`, W / 2, 1285, 42, 700, 0.95);
}

const DRAW = { streak: drawStreak, today: drawToday, week: drawWeek, month: drawMonth, total: drawTotal };
function drawShare(cv, s, goal, pal, kind) {
  cv.width = W; cv.height = H; const ctx = cv.getContext('2d'); ctx.textBaseline = 'alphabetic';
  DRAW[kind](ctx, s, goal, pal);
}

function shareCard(s, goal, startKind) {
  phraseSeed = Math.floor(Math.random() * 1000);
  const cv = h('canvas', { class: 'sharecv' }); let pi = 0, kind = startKind || (s.streak > 0 ? 'streak' : 'today'), blob = null;
  const fname = () => `recly-${kind}.png`, file = () => new File([blob], fname(), { type: 'image/png' });
  const seg = h('div', { class: 'seg' });
  const redraw = () => {
    drawShare(cv, s, goal, PALETTES[pi], kind); blob = null; cv.toBlob(b => { blob = b; }, 'image/png');
    [...seg.children].forEach(b => b.classList.toggle('on', b.dataset.k === kind));
  };
  SHARE_KINDS.forEach(([k, label]) => seg.append(h('button', { class: 'segb', 'data-k': k, onclick: () => { kind = k; redraw(); } }, label)));
  redraw();
  const download = () => { if (!blob) return; const a = h('a', { href: URL.createObjectURL(blob), download: fname() }); document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000); };
  const m = modal([h('h3', null, 'Compartilhar progresso'), seg, h('div', { class: 'sharebox' }, cv),
    h('div', { class: 'col' },
      h('button', { class: 'btn primary', onclick: async () => {
        if (!blob) return;
        try { if (navigator.canShare && navigator.canShare({ files: [file()] })) { await navigator.share({ files: [file()], text: 'Meu progresso no Recly 📚' }); return; } } catch (e) { if (e.name === 'AbortError') return; }
        download();
      } }, 'Compartilhar / Salvar imagem'),
      h('div', { class: 'grid2' }, h('button', { class: 'btn', onclick: () => { pi = (pi + 1) % PALETTES.length; redraw(); } }, '🎨 Trocar cores'),
        h('button', { class: 'btn', onclick: () => { phraseSeed++; redraw(); } }, '💬 Trocar frase')),
      h('button', { class: 'btn', onclick: () => m.close() }, 'Fechar'))], { full: true });
}

// Aba "Loja": vitrine em 2 colunas + página de produto em tela cheia.
const money = s => String(s || '').trim();
const ICONS = {
  check: '<path d="M20 6 9 17l-5-5"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
  zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z"/>',
  infinity: '<path d="M18.2 8.5a4.5 4.5 0 1 1 0 7c-2.2-1.6-4.2-5.4-6.2-7a4.5 4.5 0 1 0 0 7c2-1.6 4-5.4 6.2-7Z"/>',
  offline: '<path d="M2 8.8a15 15 0 0 1 4.2-2.6M10.7 5.1A15 15 0 0 1 22 8.8M5 12.9a10 10 0 0 1 5.2-2.7M19 12.9a10 10 0 0 0-2.3-1.7M8.5 16.4a5 5 0 0 1 7 0M12 20h.01M2 2l20 20"/>',
  cards: '<rect x="3" y="6" width="13" height="15" rx="2"/><path d="M8 3h11a2 2 0 0 1 2 2v13"/>',
  book: '<path d="M4 19.5V5a2 2 0 0 1 2-2h14v16H6.5a2.5 2.5 0 0 0 0 5H20"/>',
  repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5"/>',
  cart: '<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6"/>',
  pkg: '<path d="m7.5 4.3 9 5.2M21 8 12 3 3 8v8l9 5 9-5V8Z"/><path d="M3.3 7 12 12l8.7-5M12 22V12"/>',
  chev: '<path d="m6 9 6 6 6-6"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
};
const ico = (n, cls = 'ic') => h('span', { class: cls, html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[n]}</svg>` });

/** Capa: a imagem do produto; sem imagem, uma capa gerada com o nome do baralho. */
function shopCover(it, cls, withBadge = true) {
  const c1 = it.color || '#2563eb';
  const box = h('div', { class: cls + ' gen', style: `--c:${c1}` },
    h('div', { class: 'gtop' }, h('span', null, 'Recly'), it.category ? h('span', null, it.category) : null),
    h('div', { class: 'gtitle' }, it.coverTitle || it.title),
    it.cards ? h('div', { class: 'gfoot' }, `${Number(it.cards).toLocaleString('pt-BR')} cartões`) : null);
  if (it.image) {
    const img = h('img', { src: it.image, alt: it.title || '', loading: 'lazy' });
    img.onload = () => box.classList.remove('gen');
    img.onerror = () => img.remove();
    box.append(img);
  }
  if (withBadge && it.badge) box.append(h('b', { class: 'pbadge' }, it.badge));
  return box;
}
function discountOf(it) {
  const n = s => parseFloat(String(s || '').replace(/[^\d,]/g, '').replace(',', '.'));
  const a = n(it.oldPrice), b = n(it.price);
  return a > b && b > 0 ? Math.round((1 - b / a) * 100) : 0;
}

async function viewShop(v) {
  v.append(h('header', { class: 'top' }, h('h1', null, 'Loja'), h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: doImport }, '⬇ Importar'))));
  const box = h('div', null, h('div', { class: 'spinner' })); v.append(box);
  const { cat, offline } = await Shop.catalog();
  if (currentTab !== 'shop') return;
  box.innerHTML = '';
  const items = (cat && cat.products) || [];
  if (offline) box.append(h('div', { class: 'shopnote' }, '📡 Sem conexão: mostrando a última lista salva. Para comprar é preciso internet.'));
  if (!items.length) {
    box.append(h('div', { class: 'welcome' }, h('div', { class: 'wl-ic' }, '🛍️'), h('h2', null, cat ? 'Novos baralhos em breve' : 'Loja indisponível'),
      h('p', { class: 'muted' }, cat ? 'Volte aqui para conferir as novidades.' : 'Conecte-se à internet para carregar a loja.')));
    return;
  }
  if (cat.headline) box.append(h('p', { class: 'shophead' }, cat.headline));
  box.append(h('div', { class: 'pgrid' }, items.map(it => {
    const off = discountOf(it);
    return h('button', { class: 'pcard', onclick: () => productPage(it) },
      shopCover(it, 'pcov'),
      h('div', { class: 'pinfo' },
        h('div', { class: 'ptitle' }, it.title),
        it.subtitle ? h('div', { class: 'psub' }, it.subtitle) : null,
        h('div', { class: 'pprice' }, it.oldPrice ? h('s', null, money(it.oldPrice)) : null, h('b', null, money(it.price)), off ? h('i', null, `-${off}%`) : null),
        it.sample ? h('div', { class: 'psample' }, ico('gift', 'ic s'), 'Baixe a amostra grátis') : null));
  })));
  box.append(h('p', { class: 'muted center s' }, 'Toque em um baralho para ver todos os detalhes.'));
}

function productPage(it) {
  const off = discountOf(it);
  const buy = () => it.checkout ? window.open(it.checkout, '_blank', 'noopener') : alertBox('Link de compra indisponível.');
  const sec = (title, ...kids) => h('section', { class: 'xsec' }, h('h3', null, title), ...kids);
  const priceBlock = cls => h('div', { class: cls },
    it.oldPrice || off ? h('div', { class: 'xold' }, it.oldPrice ? h('s', null, money(it.oldPrice)) : null, off ? h('i', null, `${off}% OFF`) : null) : null,
    h('div', { class: 'xnow' }, money(it.price)),
    it.installments ? h('div', { class: 'xinst' }, it.installments) : null);
  const stats = [it.cards ? ['cards', Number(it.cards).toLocaleString('pt-BR'), 'cartões'] : null,
    it.subjects ? ['book', String(it.subjects), 'matérias'] : null,
    ['offline', 'Offline', 'estude sem internet'], ['repeat', 'Revisão', 'espaçada inteligente']].filter(Boolean).slice(0, 4);
  const trust = [['zap', 'Acesso imediato'], ['infinity', 'Compra única'], it.guarantee ? ['shield', 'Garantia'] : ['offline', 'Funciona offline']];
  const steps = [it.sample ? ['Experimente', 'Baixe a amostra grátis e estude alguns cartões.'] : null,
    ['Compre', 'Toque em “Comprar agora” e finalize pela Kiwify (Pix ou cartão).'],
    ['Baixe', 'Salve o arquivo .apkg recebido após a compra no app Arquivos.'],
    ['Importe', 'No Recly, toque em “Importar” e escolha o arquivo. Pronto!']].filter(Boolean);

  const ov = h('div', { class: 'ppage' });
  const bar = h('div', { class: 'pbar' }, h('button', { class: 'pback', onclick: () => close() }, ico('back', 'ic'), 'Loja'), h('span', { class: 'pbt' }, it.title));
  const close = () => { ov.classList.add('out'); setTimeout(() => ov.remove(), 220); };
  const scroll = h('div', { class: 'pscroll' },
    h('div', { class: 'xwrap' },
      h('div', { class: 'xhero' }, shopCover(it, 'phero', false)),
      h('div', { class: 'xhead' },
        h('div', { class: 'xtags' }, it.badge ? h('span', { class: 'xtag hot' }, it.badge) : null, it.category ? h('span', { class: 'xtag' }, it.category) : null),
        h('h1', { class: 'xtitle' }, it.title),
        it.subtitle ? h('p', { class: 'xsub' }, it.subtitle) : null),
      h('div', { class: 'xbuy' },
        priceBlock('xprice'),
        h('button', { class: 'btn primary big wide xcta', onclick: buy }, ico('cart', 'ic'), 'Comprar agora'),
        it.sample ? h('button', { class: 'btn big wide xsample', onclick: () => importSample(it) }, ico('gift', 'ic'), 'Baixar amostra grátis') : null,
        h('div', { class: 'xsecure' }, ico('lock', 'ic s'), 'Pagamento seguro processado pela Kiwify')),
      h('div', { class: 'xtrust' }, trust.map(([i, t]) => h('div', null, ico(i, 'ic'), h('span', null, t)))),
      sec('Destaques', h('div', { class: 'xstats' }, stats.map(([i, a, b]) => h('div', null, ico(i, 'ic'), h('b', null, a), h('small', null, b))))),
      it.desc ? sec('Sobre este baralho', h('div', { class: 'xdesc' }, String(it.desc).split(/\n+/).map(p => h('p', null, p)))) : null,
      it.benefits && it.benefits.length ? sec('Por que escolher', h('ul', { class: 'xchecks' }, it.benefits.map(b => h('li', null, ico('check', 'ic ok'), h('span', null, b))))) : null,
      it.topics && it.topics.length ? sec('Conteúdo', h('ol', { class: 'xtopics' }, it.topics.map(t => h('li', null, t)))) : null,
      it.includes && it.includes.length ? sec('O que você recebe', h('ul', { class: 'xchecks' }, it.includes.map(b => h('li', null, ico('pkg', 'ic'), h('span', null, b))))) : null,
      sec('Como funciona', h('ol', { class: 'xsteps' }, steps.map(([t, d]) => h('li', null, h('b', null, t), h('span', null, d))))),
      it.guarantee ? h('section', { class: 'xsec xguar' }, ico('shield', 'ic big'), h('div', null, h('h3', null, 'Compra garantida'), h('p', null, it.guarantee))) : null,
      it.faq && it.faq.length ? sec('Perguntas frequentes', h('div', { class: 'xfaq' }, it.faq.map(f => h('details', null, h('summary', null, h('span', null, f.q), ico('chev', 'ic s')), h('p', null, f.a))))) : null,
      h('section', { class: 'xsec xend' }, h('h3', null, 'Pronto para começar?'), h('p', null, it.title),
        priceBlock('xprice c'), h('button', { class: 'btn primary big wide xcta', onclick: buy }, ico('cart', 'ic'), 'Comprar agora'))));
  scroll.addEventListener('scroll', () => bar.classList.toggle('t', scroll.scrollTop > 260), { passive: true });
  ov.append(bar, scroll,
    h('div', { class: 'pfoot' }, h('div', null, it.oldPrice ? h('s', null, money(it.oldPrice)) : null, h('b', null, money(it.price))),
      h('button', { class: 'btn primary', onclick: buy }, 'Comprar agora')));
  document.body.append(ov);
}

async function importSample(it) {
  const b = busy('Baixando amostra…');
  try {
    let r; try { r = await fetch(it.sample, { cache: 'no-store' }); } catch (e) { throw new Error('Sem conexão. Conecte-se à internet para baixar a amostra.'); }
    if (!r.ok) throw new Error('A amostra ainda não está disponível. Tente mais tarde.');
    const file = new File([await r.blob()], 'amostra-' + (it.title || 'baralho').replace(/[^\w]+/g, '-').slice(0, 40) + '.apkg', { type: 'application/octet-stream' });
    const res = await Apkg.importFile(file, t => b.set(t)); b.close();
    await alertBox(`🎁 Amostra importada!\n${res.notes} notas, ${res.cards} cartões` + (res.skipped ? ` (${res.skipped} já existiam)` : '') + '\n\nEstude à vontade. Gostou? Volte à Loja e toque em “Comprar” para ter o baralho completo.', 'Amostra grátis');
    document.querySelectorAll('.ppage').forEach(p => p.remove()); go('decks');
  } catch (e) { console.error(e); b.close(); alertBox(e.message, 'Amostra'); }
}

// Inicialização do app.
(async function boot() {
  try {
    await Store.init();
    shell(); go('decks');
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    document.addEventListener('visibilitychange', () => { if (!document.hidden && !document.querySelector('.study') && currentTab === 'decks') refresh(); });
  } catch (e) {
    console.error(e);
    $('#app').innerHTML = '<div style="padding:24px"><h2>Não foi possível abrir o banco de dados</h2><p>' + esc(e.message || e) + '</p><p>Se você está no modo de navegação privada, saia dele e abra o app novamente.</p></div>';
  }
})();
