const express = require('express');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const app = express();
app.use(express.json());

// Serve static files but don't serve index.html automatically
app.use(express.static(__dirname, { index: false, etag: false, lastModified: false, maxAge: 0 }));

// Explicit cards.json route (bypass static caching)
app.get('/cards.json', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile('cards.json', { root: __dirname });
});

// Serve tracker.html at root
app.get('/', (req, res) => res.sendFile('tracker.html', { root: __dirname }));

// CORS for local extension access
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

const SALES_FILE = path.join(__dirname, 'sales.json');
const EXCLUDED_FILE = path.join(__dirname, 'excluded.json');
const PORT = 3010;

// Parse a Mercari URL — extract title + price from SSR meta tags
app.post('/parse', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  const match = url.match(/jp\.mercari\.com\/item\/(\w+)/);
  if (!match) return res.status(400).json({ error: 'invalid Mercari URL' });
  const item_id = match[1];

  // Check for dupe before fetching
  try {
    const sales = JSON.parse(fs.readFileSync(SALES_FILE, 'utf8'));
    if (sales.some(s => s.item_id === item_id)) {
      return res.status(409).json({ error: 'Already logged', item_id });
    }
  } catch {}

  try {
    const html = execSync(
      `curl -sL '${url}' -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'`,
      { timeout: 15000, encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 }
    );

    // Title from og:title meta tag (cleaner than <title> which has SVG junk)
    const titleMatch = html.match(/og:title['"]\s+content=['"](.*?)(?:\s+by\s+メルカリ)?['"]/);
    const title = titleMatch ? titleMatch[1].trim() : '';

    // Price from meta tag
    const priceMatch = html.match(/product:price:amount['"]\s+content=['"]([\d]+)['"]/);
    const price_jpy = priceMatch ? parseInt(priceMatch[1], 10) : null;

    res.json({ item_id, title, price_jpy });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch Mercari page', detail: e.message });
  }
});

// Save a sale record
app.post('/save', (req, res) => {
  const { item_id, title, price_jpy, card_id, grade, notes, sold_date, error_print } = req.body;
  if (!item_id || !card_id) return res.status(400).json({ error: 'item_id and card_id required' });

  let sales = [];
  try { sales = JSON.parse(fs.readFileSync(SALES_FILE, 'utf8')); } catch {}

  if (sales.some(s => s.item_id === item_id)) {
    return res.status(409).json({ error: 'Duplicate — already logged' });
  }

  const record = {
    item_id,
    title: title || '',
    price_jpy: price_jpy || null,
    price_display: price_jpy ? `¥${price_jpy.toLocaleString()}` : '',
    sold_date: sold_date || new Date().toISOString().slice(0, 10),
    card_id: card_id.toLowerCase(),
    grade: grade || '',
    notes: notes || '',
    error_print: !!error_print,
    logged_at: new Date().toISOString()
  };

  sales.push(record);
  fs.writeFileSync(SALES_FILE, JSON.stringify(sales, null, 2));
  res.json({ ok: true, record });
});

// Get all sales
app.get('/sales', (req, res) => {
  try {
    const sales = JSON.parse(fs.readFileSync(SALES_FILE, 'utf8'));
    res.json(sales);
  } catch {
    res.json([]);
  }
});

// Get all excluded
app.get('/excluded', (req, res) => {
  try {
    const excluded = JSON.parse(fs.readFileSync(EXCLUDED_FILE, 'utf8'));
    res.json(excluded);
  } catch {
    res.json([]);
  }
});

// Toggle exclude status
app.post('/exclude', (req, res) => {
  const { item_id, title, action } = req.body;
  if (!item_id) return res.status(400).json({ error: 'item_id required' });

  let excluded = [];
  try { excluded = JSON.parse(fs.readFileSync(EXCLUDED_FILE, 'utf8')); } catch {}

  if (action === 'add') {
    if (!excluded.find(e => e.item_id === item_id)) {
      excluded.push({
        item_id,
        title: title || '',
        excluded_at: new Date().toISOString()
      });
    }
  } else if (action === 'remove') {
    excluded = excluded.filter(e => e.item_id !== item_id);
  }

  fs.writeFileSync(EXCLUDED_FILE, JSON.stringify(excluded, null, 2));
  res.json({ ok: true, excluded });
});

// Delete a sale
app.delete('/sales/:item_id', (req, res) => {
  try {
    let sales = JSON.parse(fs.readFileSync(SALES_FILE, 'utf8'));
    const before = sales.length;
    sales = sales.filter(s => s.item_id !== req.params.item_id);
    if (sales.length === before) return res.status(404).json({ error: 'Not found' });
    fs.writeFileSync(SALES_FILE, JSON.stringify(sales, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`Card tracker on http://localhost:${PORT}`));