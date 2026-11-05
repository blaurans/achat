const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

function fmt(n) { return n == null ? '—' : n.toFixed(2).replace('.', ',') + ' €'; }

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// Search
$('#searchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#q').value.trim();
  if (!q) return;
  const sources = $$('input[name="src"]:checked').map(c => c.value);
  $('#status').textContent = 'Recherche en cours (peut prendre 10-20s)...';
  $('#results').innerHTML = '';
  try {
    const data = await api('/api/search?q=' + encodeURIComponent(q) + '&sources=' + sources.join(','));
    $('#status').textContent = `${data.results.length} offre(s) trouvée(s)` + (data.errors.length ? ' — erreurs: ' + data.errors.map(e=>e.source).join(',') : '');
    renderResults(data.results);
  } catch (err) {
    $('#status').textContent = 'Erreur: ' + err.message;
  }
});

function renderResults(items) {
  const tpl = $('#cardTpl');
  const container = $('#results');
  container.innerHTML = '';
  items.forEach(it => {
    const node = tpl.content.cloneNode(true);
    const img = node.querySelector('.card-img');
    img.src = it.image || '';
    img.alt = it.title;
    node.querySelector('.card-title').textContent = it.title;
    node.querySelector('.card-meta').textContent = it.source === 'amazon' ? 'Amazon.fr' : 'AliExpress';
    node.querySelector('.card-price').textContent = fmt(it.price);
    const link = node.querySelector('.link');
    link.href = it.url;
    const trackBtn = node.querySelector('.track');
    trackBtn.addEventListener('click', async () => {
      trackBtn.disabled = true;
      try {
        await api('/api/tracked', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: it.source, title: it.title, url: it.url, image: it.image, target_price: null })
        });
        trackBtn.textContent = 'Suivi ✓';
        loadTracked();
      } catch (e) { alert(e.message); trackBtn.disabled = false; }
    });
    container.appendChild(node);
  });
}

// Tracked
async function loadTracked() {
  const items = await api('/api/tracked');
  const container = $('#tracked');
  container.innerHTML = '';
  if (!items.length) { container.innerHTML = '<p class="status">Aucun produit suivi.</p>'; return; }
  items.forEach(it => {
    const el = document.createElement('div');
    el.className = 'tracked-item';
    const dealBadge = it.isDeal ? '<span class="badge">BONNE OFFRE</span>' : '';
    el.innerHTML = `
      <img src="${it.image || ''}" alt="" />
      <div>
        <p class="tracked-title">${escapeHtml(it.title)} ${dealBadge}</p>
        <div class="tracked-info">${it.source === 'amazon' ? 'Amazon.fr' : 'AliExpress'}</div>
        <div class="tracked-info">Min: ${fmt(it.minPrice)} · Moy: ${fmt(it.avgPrice)} · Max: ${fmt(it.maxPrice)}</div>
        <div class="tracked-info">Dernière vérif: ${it.lastChecked || 'jamais'}</div>
        <div class="history">${(it.prices||[]).map(p=>p.checked_at.slice(0,16)+' : '+fmt(p.price)).join(' · ')}</div>
        <div class="row" style="margin-top:6px">
          <label>Cible (€): <input type="number" step="0.01" value="${it.target_price != null ? it.target_price : ''}" data-id="${it.id}" class="target" /></label>
          <button class="btn check" data-id="${it.id}">Vérifier</button>
          <button class="btn danger del" data-id="${it.id}">Supprimer</button>
        </div>
      </div>
      <div class="tracked-price ${it.isDeal?'deal':''}">${fmt(it.lastPrice)}</div>
    `;
    container.appendChild(el);
  });
  // events
  $$('.target').forEach(inp => {
    inp.addEventListener('change', async () => {
      const v = inp.value === '' ? null : parseFloat(inp.value);
      await api('/api/tracked/' + inp.dataset.id, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ target_price: v }) });
      loadTracked();
    });
  });
  $$('.check').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = '...';
      try { await api('/api/tracked/' + btn.dataset.id + '/check', { method: 'POST' }); }
      catch (e) { alert(e.message); }
      btn.disabled = false; btn.textContent = 'Vérifier';
      loadTracked();
    });
  });
  $$('.del').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Supprimer ce suivi ?')) return;
      await api('/api/tracked/' + btn.dataset.id, { method: 'DELETE' });
      loadTracked();
    });
  });
  // browser notifications for deals
  notifyDeals(items);
}

function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

let notified = new Set();
function notifyDeals(items) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  items.filter(i => i.isDeal).forEach(i => {
    if (notified.has(i.id)) return;
    notified.add(i.id);
    new Notification('Bonne offre détectée', { body: i.title + ' — ' + (i.lastPrice != null ? i.lastPrice.toFixed(2)+' €' : '') });
  });
}

$('#checkAll').addEventListener('click', async () => {
  $('#checkAll').disabled = true;
  try { await api('/api/check-all', { method: 'POST' }); }
  catch (e) { alert(e.message); }
  $('#checkAll').disabled = false;
  loadTracked();
});

$('#notifyBtn').addEventListener('click', async () => {
  if (!('Notification' in window)) { alert('Notifications non supportées'); return; }
  const perm = await Notification.requestPermission();
  alert('Permission: ' + perm);
});

loadTracked();
setInterval(loadTracked, 60000);
