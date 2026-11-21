// Site público do Recly: abre o app se instalado e mostra preços/links a partir do catalog.json.
(function () {
  // Quem instalou o Recly pelo endereço antigo (raiz) cai direto no app.
  var standalone = window.navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
  if (standalone && location.pathname === '/') { location.replace('/app/'); return; }
  // Remove o service worker antigo que ficava na raiz.
  if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistrations().then(function (rs) {
    rs.forEach(function (r) { if (!/\/app\/$/.test(new URL(r.scope).pathname)) r.unregister(); });
  }).catch(function () {});

  var targets = document.querySelectorAll('[data-product],[data-match] [data-price]');
  if (!targets.length) return;
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var root = function (p) { return !p ? '' : /^https?:/.test(p) ? p : '/' + String(p).replace(/^\//, ''); };
  fetch('/catalog.json', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (cat) {
    var items = (cat && cat.products) || [];
    var find = function (re) { var rx = new RegExp(re, 'i'); return items.filter(function (it) { return rx.test(it.page ? it.page : (it.title || '')); }); };
    document.querySelectorAll('.ccard[data-match]').forEach(function (a) {
      var f = find(a.getAttribute('data-match')); var el = a.querySelector('[data-price]');
      if (f.length && f[0].price && el) el.textContent = (f.length > 1 ? 'a partir de ' : '') + f[0].price;
    });
    document.querySelectorAll('[data-product]').forEach(function (box) {
      var f = find(box.getAttribute('data-match'));
      if (!f.length) { box.innerHTML = '<p class="sub">Baralho em breve. Abra a <a href="/app/#loja">Loja do Recly</a> para ver as novidades.</p>'; return; }
      box.innerHTML = f.map(function (it) {
        var img = it.image ? '<img src="' + esc(root(it.image)) + '" alt="' + esc(it.title) + '" loading="lazy">' : '<div class="gcov" style="--c:' + esc(it.color || '#2563eb') + '"><span>' + esc(it.coverTitle || it.title) + '</span></div>';
        var bens = (it.benefits || []).slice(0, 4).map(function (b) { return '<li>' + esc(b) + '</li>'; }).join('');
        return '<div class="pcard2">' + img + '<div class="pbody"><h3>' + esc(it.title) + '</h3>' +
          (it.subtitle ? '<p class="sub">' + esc(it.subtitle) + '</p>' : '') +
          (it.cards ? '<p class="meta">' + Number(it.cards).toLocaleString('pt-BR') + ' cartões</p>' : '') +
          '<div class="price">' + (it.oldPrice ? '<s>' + esc(it.oldPrice) + '</s> ' : '') + '<b>' + esc(it.price || '') + '</b></div>' +
          (it.installments ? '<p class="meta">' + esc(it.installments) + '</p>' : '') +
          (bens ? '<ul class="ticks">' + bens + '</ul>' : '') +
          '<div class="cta">' + (it.checkout ? '<a class="btn" href="' + esc(it.checkout) + '" rel="noopener" target="_blank">Comprar agora</a>' : '') +
          (it.sample ? '<a class="btn ghost" href="/app/#loja">Baixar amostra grátis</a>' : '') + '</div></div></div>';
      }).join('');
    });
  }).catch(function () {
    document.querySelectorAll('[data-product]').forEach(function (box) { box.innerHTML = '<p class="sub">Abra a <a href="/app/#loja">Loja do Recly</a> para ver preço e amostra grátis.</p>'; });
  });
})();
