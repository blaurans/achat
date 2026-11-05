const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

function fmt(n) { return n == null ? '—' : Number(n).toFixed(2).replace('.', ',') + ' €'; }
function nowIso() { return new Date().toISOString().slice(0, 19).replace('T', ' '); }

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

let currentUser = null;
let trackedItems = [];

// ---------- Auth ----------
async function loadAuth() {
  try {
    const data = await api('/auth/me');
    currentUser = data.user;
  } catch (e) {
    currentUser = null;
  }
  updateAuthUI();
}

function updateAuthUI() {
  const info = $('#authInfo');
  const loginBtn = $('#loginBtn');
  const logoutBtn = $('#logoutBtn');
  if (currentUser) {
    info.textContent = `Connecté : ${currentUser.name || currentUser.email}`;
    loginBtn.style.display = 'none';
    logoutBtn.style.display = '';
  } else {
    info.textContent = 'Non connecté (données locales du navigateur)';
    loginBtn.style.display = '';
    logoutBtn.style.display = 'none';
  }
}

$('#loginBtn').addEventListener('click', () => { window.location.href = '/auth/google'; });
$('#logoutBtn').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  currentUser = null;
  trackedItems = [];
  updateAuthUI();
  loadTracked();
});

// ---------- Search ----------
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
        await trackProduct(it);
        trackBtn.textContent = 'Suivi ✓';
      } catch (e) { alert(e.message); trackBtn.disabled = false; }
    });
    container.appendChild(node);
  });
}

async function trackProduct(it) {
  if (currentUser) {
    await api('/api/tracked', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: it.source, title: it.title, url: it.url, image: it.image, target_price: null })
    });
  } else {
    const items = loadLocalTracked();
    items.push({
      _local: true,
      id: 'local_' + Date.now() + '_' + Math.random().toString(36).slice(2),
      source: it.source,
      title: it.title,
      url: it.url,
      image: it.image,
      target_price: null,
      prices: [],
      created_at: nowIso()
    });
    saveLocalTracked(items);
  }
  loadTracked();
}

// ---------- Local storage helpers ----------
function loadLocalTracked() {
  try { return JSON.parse(localStorage.getItem('tracked_anon') || '[]'); }
  catch { return []; }
}
function saveLocalTracked(items) {
  localStorage.setItem('tracked_anon', JSON.stringify(items));
}

// ---------- Tracked loading ----------
async function loadTracked() {
  if (currentUser) {
    try {
      const items = await api('/api/tracked');
      trackedItems = items.map(i => ({ ...i, _local: false }));
    } catch (e) {
      trackedItems = [];
    }
  } else {
    trackedItems = loadLocalTracked().map(i => ({ ...i, _local: true }));
  }
  renderTracked();
}

function computeStats(item) {
  const prices = item.prices || [];
  const vals = prices.map(p => (typeof p === 'object' ? p.price : p));
  const last = vals.length ? vals[vals.length - 1] : (item.lastPrice != null ? item.lastPrice : null);
  const min = vals.length ? Math.min(...vals) : item.minPrice;
  const max = vals.length ? Math.max(...vals) : item.maxPrice;
  const avg = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : item.avgPrice;
  let deal = false;
  if (last != null && item.target_price != null && last <= item.target_price) deal = true;
  if (last != null && avg != null && last <= avg * 0.9) deal = true;
  if (last != null && min != null && last <= min) deal = true;
  return { last, min, max, avg, deal };
}

function renderTracked() {
  const container = $('#tracked');
  container.innerHTML = '';
  if (!trackedItems.length) {
    container.innerHTML = '<p class="status">Aucun produit suivi.</p>';
    return;
  }
  trackedItems.forEach(it => {
    const stats = computeStats(it);
    const dealBadge = stats.deal ? '<span class="badge">BONNE OFFRE</span>' : '';
    const el = document.createElement('div');
    el.className = 'tracked-item';
    el.innerHTML = `
      <img src="${it.image || ''}" alt="" />
      <div>
        <p class="tracked-title">${escapeHtml(it.title)} ${dealBadge}</p>
        <div class="tracked-info">${it.source === 'amazon' ? 'Amazon.fr' : 'AliExpress'}${it._local ? ' · local' : ''}</div>
        <div class="tracked-info">Min: ${fmt(stats.min)} · Moy: ${fmt(stats.avg)} · Max: ${fmt(stats.max)}</div>
        <div class="tracked-info">Dernière vérif: ${it.lastChecked || (it.prices && it.prices.length ? it.prices[it.prices.length-1].checked_at : 'jamais')}</div>
        <div class="history">${(it.prices||[]).map(p => (typeof p==='object' ? p.checked_at : '') + ' : ' + fmt(typeof p==='object'?p.price:p)).join(' · ')}</div>
        <div class="row" style="margin-top:6px">
          <label>Cible (€): <input type="number" step="0.01" value="${it.target_price != null ? it.target_price : ''}" data-id="${it.id}" class="target" /></label>
          <button class="btn check" data-id="${it.id}">Vérifier</button>
          <button class="btn danger del" data-id="${it.id}">Supprimer</button>
        </div>
      </div>
      <div class="tracked-price ${stats.deal?'deal':''}">${fmt(stats.last)}</div>
    `;
    container.appendChild(el);
  });

  // events
  $$('.target').forEach(inp => {
    inp.addEventListener('change', async () => {
      const v = inp.value === '' ? null : parseFloat(inp.value);
      const item = trackedItems.find(t => String(t.id) === String(inp.dataset.id));
      if (!item) return;
      item.target_price = v;
      if (item._local) {
        saveLocalTracked(trackedItems.filter(t => t._local));
      } else if (currentUser) {
        await api('/api/tracked/' + item.id, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ target_price: v }) });
      }
      renderTracked();
    });
  });
  $$('.check').forEach(btn => {
    btn.addEventListener('click', async () => {
      const item = trackedItems.find(t => String(t.id) === String(btn.dataset.id));
      if (!item) return;
      btn.disabled = true; btn.textContent = '...';
      try {
        if (item._local) {
          const r = await api('/api/check-price', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ source: item.source, url: item.url, title: item.title }) });
          if (r.price != null) {
            item.prices = item.prices || [];
            item.prices.push({ price: r.price, checked_at: nowIso() });
            saveLocalTracked(trackedItems.filter(t => t._local));
          }
        } else if (currentUser) {
          await api('/api/tracked/' + item.id + '/check', { method: 'POST' });
        }
      } catch (e) { alert(e.message); }
      btn.disabled = false; btn.textContent = 'Vérifier';
      loadTracked();
    });
  });
  $$('.del').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Supprimer ce suivi ?')) return;
      const item = trackedItems.find(t => String(t.id) === String(btn.dataset.id));
      if (!item) return;
      if (item._local) {
        trackedItems = trackedItems.filter(t => t.id !== item.id);
        saveLocalTracked(trackedItems.filter(t => t._local));
      } else if (currentUser) {
        await api('/api/tracked/' + item.id, { method: 'DELETE' });
      }
      loadTracked();
    });
  });

  notifyDeals(trackedItems);
}

function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

let notified = new Set();
function notifyDeals(items) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  items.forEach(i => {
    const stats = computeStats(i);
    if (!stats.deal) return;
    if (notified.has(i.id)) return;
    notified.add(i.id);
    new Notification('Bonne offre détectée', { body: i.title + ' — ' + fmt(stats.last) });
  });
}

$('#checkAll').addEventListener('click', async () => {
  $('#checkAll').disabled = true;
  try {
    if (currentUser) {
      await api('/api/check-all', { method: 'POST' });
    } else {
      // check all local items
      for (const item of trackedItems.filter(t => t._local)) {
        const r = await api('/api/check-price', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ source: item.source, url: item.url, title: item.title }) });
        if (r.price != null) {
          item.prices = item.prices || [];
          item.prices.push({ price: r.price, checked_at: nowIso() });
        }
      }
      saveLocalTracked(trackedItems.filter(t => t._local));
    }
  } catch (e) { alert(e.message); }
  $('#checkAll').disabled = false;
  loadTracked();
});

$('#notifyBtn').addEventListener('click', async () => {
  if (!('Notification' in window)) { alert('Notifications non supportées'); return; }
  const perm = await Notification.requestPermission();
  alert('Permission: ' + perm);
});

// ---------- Init ----------
(async () => {
  await loadAuth();
  await loadTracked();
  setInterval(loadTracked, 60000);
})();
