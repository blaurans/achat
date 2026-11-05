const express = require('express');
const Database = require('better-sqlite3');
const { chromium } = require('playwright');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const CHROMIUM = process.env.CHROMIUM || '/usr/bin/chromium';
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-in-production-please';
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const SECURE = BASE_URL.startsWith('https');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx < 0) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx+1).trim();
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  });
  return out;
}
function signSession(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  return data + '.' + sig;
}
function verifySession(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch { return null; }
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString());
    if (payload.exp && payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}
app.use((req, res, next) => {
  const cookies = parseCookies(req.headers.cookie);
  const session = verifySession(cookies.session);
  req.user = null;
  if (session && session.uid) {
    req.user = db.prepare('SELECT * FROM users WHERE id=?').get(session.uid) || null;
  }
  next();
});


const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'deals.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS tracked (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  image TEXT,
  target_price REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tracked_id INTEGER NOT NULL,
  price REAL NOT NULL,
  currency TEXT DEFAULT 'EUR',
  checked_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(tracked_id) REFERENCES tracked(id) ON DELETE CASCADE
);
`);
db.exec(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  google_sub TEXT UNIQUE NOT NULL,
  email TEXT,
  name TEXT,
  picture TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);
const trackedCols = db.prepare('PRAGMA table_info(tracked)').all().map(c=>c.name);
if (!trackedCols.includes('user_id')) {
  db.exec('ALTER TABLE tracked ADD COLUMN user_id INTEGER REFERENCES users(id)');
}

let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true, executablePath: CHROMIUM, args: ['--no-sandbox','--disable-blink-features=AutomationControlled'] });
  }
  return browserPromise;
}
async function newStealthPage(browser) {
  const context = await browser.newContext({
    locale: 'fr-FR',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  });
  await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  const page = await context.newPage();
  page._context = context;
  return page;
}

function parsePrice(str) {
  if (!str) return null;
  const cleaned = String(str).replace(/[^\d.,]/g, '').replace(/\s/g, '');
  // handle 1.234,56 or 1,234.56
  let val;
  if (cleaned.includes(',') && cleaned.includes('.')) {
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
      val = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      val = cleaned.replace(/,/g, '');
    }
  } else if (cleaned.includes(',')) {
    val = cleaned.replace(',', '.');
  } else {
    val = cleaned;
  }
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

async function scrapeAmazon(query) {
  const browser = await getBrowser();
  const page = await newStealthPage(browser);
  try {
    await page.goto('https://www.amazon.fr/s?k=' + encodeURIComponent(query), { timeout: 45000 });
    await page.waitForSelector('[data-component-type="s-search-result"]', { timeout: 20000 }).catch(() => {});
    const items = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('[data-component-type="s-search-result"]').forEach(el => {
        const asin = el.getAttribute('data-asin');
        const h2 = el.querySelector('h2');
        const title = h2 ? h2.textContent.trim() : '';
        const priceEl = el.querySelector('.a-price .a-offscreen');
        const imgEl = el.querySelector('img.s-image');
        const ratingEl = el.querySelector('.a-icon-alt');
        if (!asin || !title) return;
        out.push({
          id: asin,
          title,
          price: priceEl ? priceEl.textContent.trim() : null,
          image: imgEl ? imgEl.src : null,
          rating: ratingEl ? ratingEl.textContent.trim() : null,
          url: 'https://www.amazon.fr/dp/' + asin,
        });
      });
      return out;
    });
    return items.map(it => ({ ...it, source: 'amazon', price: parsePrice(it.price) }));
  } finally {
    await page._context.close();
  }
}

async function scrapeAliExpress(query) {
  const browser = await getBrowser();
  const page = await newStealthPage(browser);
  try {
    await page.goto('https://www.aliexpress.com/wholesale?SearchText=' + encodeURIComponent(query), { timeout: 45000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(7000);
    const items = await page.evaluate(() => {
      const out = [];
      const seen = new Set();
      const anchors = Array.from(document.querySelectorAll('a')).filter(a => /\/item\//.test(a.href));
      for (const a of anchors) {
        const m = a.href.match(/\/item\/(\d+)\.html/);
        const id = m ? m[1] : a.href;
        if (seen.has(id)) continue;
        seen.add(id);
        const img = a.querySelector('img');
        const h3 = a.querySelector('h3');
        const title = (h3 ? h3.textContent : (a.getAttribute('title') || '')).trim();
        let price = null;
        const priceEl = Array.from(a.querySelectorAll('*')).find(e => e.childElementCount === 0 && /€/.test(e.textContent) && e.textContent.length < 20);
        if (priceEl) price = priceEl.textContent.trim();
        if (!title) continue;
        let href = a.getAttribute('href');
        if (href.startsWith('//')) href = 'https:' + href;
        out.push({ id, title, price, image: img ? img.src : null, url: href.split('?')[0] + (href.includes('?') ? '?' + href.split('?')[1].split('&').slice(0,1).join('') : '') });
      }
      return out;
    });
    // clean url to full
    const cleaned = items.map(it => {
      // keep full url already
      return { ...it, source: 'aliexpress', price: parsePrice(it.price) };
    });
    return cleaned;
  } finally {
    await page._context.close();
  }
}


// Auth (Google OAuth, optional)
app.get('/auth/google', (req, res) => {
  if (!CLIENT_ID || !CLIENT_SECRET) return res.status(500).send('Google OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.');
  const state = crypto.randomBytes(16).toString('hex');
  res.setHeader('Set-Cookie', `oauth_state=${state}; HttpOnly; ${SECURE?'Secure; ':''}SameSite=Lax; Path=/; Max-Age=300`);
  const redirectUri = BASE_URL + '/auth/google/callback';
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account'
  }).toString();
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, state } = req.query;
  const cookies = parseCookies(req.headers.cookie);
  if (!code || !state || state !== cookies.oauth_state) return res.status(400).send('Invalid OAuth state');
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: BASE_URL + '/auth/google/callback',
        grant_type: 'authorization_code'
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error(tokenData.error_description || 'token error');
    const userRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: 'Bearer ' + tokenData.access_token }
    });
    const profile = await userRes.json();
    if (!profile.sub) throw new Error('no profile');
    let user = db.prepare('SELECT * FROM users WHERE google_sub=?').get(profile.sub);
    if (!user) {
      const info = db.prepare('INSERT INTO users (google_sub,email,name,picture) VALUES (?,?,?,?)').run(profile.sub, profile.email || null, profile.name || null, profile.picture || null);
      user = db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid);
    } else {
      db.prepare('UPDATE users SET email=?,name=?,picture=? WHERE id=?').run(profile.email || null, profile.name || null, profile.picture || null, user.id);
      user = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
    }
    const sessionToken = signSession({ uid: user.id, exp: Date.now() + 30*24*60*60*1000 });
    res.setHeader('Set-Cookie', [
      `session=${sessionToken}; HttpOnly; ${SECURE?'Secure; ':''}SameSite=Lax; Path=/; Max-Age=${30*24*60*60}`,
      `oauth_state=; HttpOnly; ${SECURE?'Secure; ':''}SameSite=Lax; Path=/; Max-Age=0`
    ]);
    res.redirect('/');
  } catch (e) {
    console.error('OAuth error', e);
    res.status(500).send('Authentication failed: ' + e.message);
  }
});

app.get('/auth/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({ user: { id: req.user.id, email: req.user.email, name: req.user.name, picture: req.user.picture } });
});

app.post('/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', `session=; HttpOnly; ${SECURE?'Secure; ':''}SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'missing q' });
  const sources = (req.query.sources || 'amazon,aliexpress').split(',').map(s => s.trim());
  const results = [];
  const errors = [];
  const tasks = [];
  if (sources.includes('amazon')) tasks.push(scrapeAmazon(q).then(r => results.push(...r)).catch(e => errors.push({ source: 'amazon', error: e.message })));
  if (sources.includes('aliexpress')) tasks.push(scrapeAliExpress(q).then(r => results.push(...r)).catch(e => errors.push({ source: 'aliexpress', error: e.message })));
  await Promise.all(tasks);
  // sort by price asc when available
  results.sort((a, b) => {
    const pa = a.price == null ? Infinity : a.price;
    const pb = b.price == null ? Infinity : b.price;
    return pa - pb;
  });
  res.json({ query: q, results, errors });
});

// Tracked products
app.get('/api/tracked', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'auth required' });
  const rows = db.prepare('SELECT * FROM tracked WHERE user_id=? ORDER BY created_at DESC').all(req.user.id);
  const out = rows.map(r => {
    const prices = db.prepare('SELECT price, checked_at FROM prices WHERE tracked_id=? ORDER BY checked_at ASC').all(r.id);
    const last = prices.length ? prices[prices.length - 1] : null;
    const min = prices.length ? Math.min(...prices.map(p => p.price)) : null;
    const max = prices.length ? Math.max(...prices.map(p => p.price)) : null;
    const avg = prices.length ? prices.reduce((s, p) => s + p.price, 0) / prices.length : null;
    let deal = false;
    if (last && r.target_price != null && last.price <= r.target_price) deal = true;
    if (last && avg != null && last.price <= avg * 0.9) deal = true;
    if (last && min != null && last.price <= min) deal = true;
    return { ...r, prices, lastPrice: last ? last.price : null, lastChecked: last ? last.checked_at : null, minPrice: min, maxPrice: max, avgPrice: avg, isDeal: deal };
  });
  res.json(out);
});

app.post('/api/tracked', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'auth required' });
  const { source, title, url, image, target_price } = req.body || {};
  if (!source || !title || !url) return res.status(400).json({ error: 'missing fields' });
  const info = db.prepare('INSERT INTO tracked (source, title, url, image, target_price, user_id) VALUES (?,?,?,?,?,?)').run(source, title, url, image || null, target_price != null ? target_price : null, req.user.id);
  res.json({ id: info.lastInsertRowid });
});

app.delete('/api/tracked/:id', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'auth required' });
  db.prepare('DELETE FROM tracked WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

app.patch('/api/tracked/:id', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'auth required' });
  const { target_price } = req.body || {};
  db.prepare('UPDATE tracked SET target_price=? WHERE id=? AND user_id=?').run(target_price != null ? target_price : null, req.params.id, req.user.id);
  res.json({ ok: true });
});

async function fetchPrice(row) {
  const browser = await getBrowser();
  const page = await newStealthPage(browser);
  try {
    let price = null;
    if (row.source === 'amazon') {
      await page.goto(row.url, { timeout: 45000, waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(4000);
      price = await page.evaluate(() => {
        const el = document.querySelector('.a-price .a-offscreen, #priceblock_ourprice, #priceblock_dealprice');
        return el ? el.textContent.trim() : null;
      });
    } else {
      const idMatch = row.url.match(/\/item\/(\d+)\.html/);
      const itemId = idMatch ? idMatch[1] : null;
      const query = (row.title || '').split(/\s+/).slice(0, 8).join(' ');
      await page.goto('https://www.aliexpress.com/wholesale?SearchText=' + encodeURIComponent(query), { timeout: 45000, waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(8000);
      price = await page.evaluate((targetId) => {
        const anchors = Array.from(document.querySelectorAll('a')).filter(a => /\/item\//.test(a.href));
        for (const a of anchors) {
          const m = a.href.match(/\/item\/(\d+)\.html/);
          if (!m) continue;
          if (targetId && m[1] !== targetId) continue;
          const candidates = Array.from(a.querySelectorAll('*')).filter(e => e.childElementCount === 0 && /€/.test(e.textContent) && e.textContent.length < 20);
          const clean = candidates.find(e => /^\s*[\d\s.,]+€\s*$/.test(e.textContent.trim()));
          const el = clean || candidates[0];
          return el ? el.textContent.trim() : null;
        }
        return null;
      }, itemId);
    }
    const p = parsePrice(price);
    return { price: p, raw: price };
  } finally {
    await page._context.close();
  }
}


async function checkPrice(row) {
  const { price, raw } = await fetchPrice(row);
  if (price != null && row.id) {
    db.prepare('INSERT INTO prices (tracked_id, price) VALUES (?,?)').run(row.id, price);
  }
  return { id: row.id, price, raw };
}

app.post('/api/tracked/:id/check', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'auth required' });
  const row = db.prepare('SELECT * FROM tracked WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  try {
    const r = await checkPrice(row);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/check-all', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'auth required' });
  const rows = db.prepare('SELECT * FROM tracked WHERE user_id=?').all(req.user.id);
  const results = [];
  for (const row of rows) {
    try {
      results.push(await checkPrice(row));
    } catch (e) {
      results.push({ id: row.id, error: e.message });
    }
  }
  res.json(results);
});

// background checks every 30 min
setInterval(async () => {
  const rows = db.prepare('SELECT * FROM tracked').all();
  for (const row of rows) {
    try { await checkPrice(row); } catch (e) { /* ignore */ }
  }
}, 30 * 60 * 1000);


app.post('/api/check-price', async (req, res) => {
  const { source, url, title } = req.body || {};
  if (!source || !url) return res.status(400).json({ error: 'missing fields' });
  try {
    const r = await fetchPrice({ source, url, title });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Product deals running on http://localhost:${PORT}`);
});
