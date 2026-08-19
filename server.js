// ============================================================
//  DofLib — PostgreSQL / Railway
//  Nécessite la variable DATABASE_URL (fournie par Railway
//  automatiquement quand le service est lié à une base Postgres)
// ============================================================

const express = require('express');
const path = require('path');
const https = require('https');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL manquante. Crée une base PostgreSQL sur Railway et lie-la au service.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000
});

// ---------- Schéma (créé automatiquement au démarrage) ----------
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS objectifs (
    id SERIAL PRIMARY KEY,
    titre TEXT NOT NULL,
    description TEXT DEFAULT '',
    quantite INTEGER DEFAULT 1,
    deadline DATE,
    statut TEXT DEFAULT 'a_faire' CHECK (statut IN ('a_faire','en_cours','fait')),
    "createdAt" TIMESTAMPTZ DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS prix_hdv (
    id SERIAL PRIMARY KEY,
    item_name TEXT NOT NULL,
    prix INTEGER NOT NULL,
    quantite INTEGER DEFAULT 1,
    date DATE DEFAULT CURRENT_DATE,
    "createdAt" TIMESTAMPTZ DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS brouillons (
    id SERIAL PRIMARY KEY,
    titre TEXT DEFAULT 'Sans titre',
    contenu TEXT DEFAULT '',
    "createdAt" TIMESTAMPTZ DEFAULT now(),
    "updatedAt" TIMESTAMPTZ DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS stuffs (
    id SERIAL PRIMARY KEY,
    nom TEXT NOT NULL,
    items TEXT DEFAULT '[]',
    description TEXT DEFAULT '',
    "createdAt" TIMESTAMPTZ DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS farm_items (
    id SERIAL PRIMARY KEY,
    item_id INTEGER NOT NULL,
    item_name TEXT NOT NULL,
    quantite INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS inventaire (
    id SERIAL PRIMARY KEY,
    item_name TEXT NOT NULL UNIQUE,
    quantite INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS attributions (
    id SERIAL PRIMARY KEY,
    item_name TEXT NOT NULL,
    personnage TEXT NOT NULL,
    compte TEXT DEFAULT '',
    quantite INTEGER DEFAULT 1,
    statut TEXT DEFAULT 'a_farmer' CHECK (statut IN ('a_farmer','a_crafter','en_cours','fait')),
    "createdAt" TIMESTAMPTZ DEFAULT now()
  );

  ALTER TABLE attributions ADD COLUMN IF NOT EXISTS statut TEXT DEFAULT 'a_farmer';

  CREATE TABLE IF NOT EXISTS dofus_items (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    level INTEGER DEFAULT 0,
    type TEXT DEFAULT '',
    img_url TEXT DEFAULT '',
    data JSONB DEFAULT '{}',
    "updatedAt" TIMESTAMPTZ DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS idx_dofus_items_name ON dofus_items (lower(name));
  CREATE INDEX IF NOT EXISTS idx_dofus_items_level ON dofus_items (level);
`;

async function initDb() {
  for (let i = 0; i < 15; i++) {
    try {
      await pool.query(SCHEMA);
      console.log('📦 Base PostgreSQL prête (schéma initialisé)');
      return;
    } catch (e) {
      console.log(`⏳ Attente PostgreSQL... (${i + 1}/15) — ${e.message}`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  throw new Error('Impossible de se connecter à PostgreSQL après 15 tentatives.');
}

// ---------- Cache API DofusDB ----------
const itemCache = new Map();

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'fr-FR,fr;q=0.9'
      },
      timeout: 15000
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode !== 200) reject(new Error(`API HTTP ${res.statusCode}`));
          else resolve(parsed);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('Timeout API DofusDB'));
    });
  });
}

async function fetchRecipe(itemId) {
  const cached = itemCache.get(itemId);
  if (cached && cached.recipe) return cached.recipe;

  const json = await fetchJson(`https://api.dofusdb.fr/recipes?resultId=${itemId}`);
  const recipe = (json.data && json.data[0]) || null;

  const entry = itemCache.get(itemId) || {};
  entry.recipe = recipe;
  itemCache.set(itemId, entry);
  return recipe;
}

async function searchDofusDB(query) {
  // 1) Recherche locale d'abord (base scrappée)
  const local = await searchLocalItems(query, 20);
  if (local.length > 0) {
    return local.map(r => ({ id: r.id, name: r.name, level: r.level, type: r.type, img_url: r.img_url }));
  }

  // 2) Fallback API en direct si la base est vide/incomplète
  try {
    const url = `https://api.dofusdb.fr/items?search[name]=${encodeURIComponent(query)}&lang=fr&limit=8`;
    const json = await fetchJson(url);
    return (json.data || []).map(i => {
      if (!itemCache.has(i.id)) {
        itemCache.set(i.id, { name: (i.name && i.name.fr) ? i.name.fr : 'Inconnu', level: i.level || 0 });
      }
      return {
        id: i.id,
        name: (i.name && i.name.fr) ? i.name.fr : 'Inconnu',
        level: i.level || 0,
        type: itemTypeName(i),
        img_url: i.imgUrl || ''
      };
    });
  } catch (e) {
    console.error('⚠️ Fallback API DofusDB échoué:', e.message);
    return [];
  }
}

function getItemName(item) {
  if (item.name && item.name.fr) return item.name.fr;
  const cached = itemCache.get(item.id);
  return (cached && cached.name) || 'Inconnu';
}

// ============================================================
//  SCRAPING COMPLET DOFUSDB → POSTGRES
//  Aspire tous les items et les stocke dans la table dofus_items.
//  Reprise automatique : les items déjà en base ne sont pas retéléchargés.
// ============================================================
const scrapeState = {
  running: false,
  total: 0,
  done: 0,
  page: 0,
  errors: [],
  typeFilter: null   // null = tous les types, sinon nom de type (ex: "Ressource")
};

const CONCURRENCY = 6;   // requêtes API en parallèle
const PAGE_SIZE = 100;   // items par page DofusDB

function itemTypeName(i) {
  if (i.type && i.type.name && i.type.name.fr) return i.type.name.fr;
  if (i.typeName) return i.typeName;
  if (i.type && typeof i.type === 'object') {
    for (const k of ['fr', 'en', 'de', 'es', 'it', 'pt', 'ru']) {
      if (i.type.name && i.type.name[k]) return i.type.name[k];
    }
  }
  return '';
}

function buildItemRow(i) {
  const names = i.name || {};
  const nameFr = names.fr || names.en || names.de || 'Inconnu';
  return {
    id: i.id,
    name: nameFr,
    level: i.level || 0,
    type: itemTypeName(i),
    img_url: i.imgUrl || '',
    data: {
      id: i.id,
      name: names,
      level: i.level || 0,
      type: i.type || null,
      typeName: i.typeName || '',
      imgUrl: i.imgUrl || '',
      recipeIds: i.recipeIds || [],
      isHeavy: i.isHeavy || false,
      isTwoHanded: i.isTwoHanded || false
    }
  };
}

async function upsertItems(rows) {
  if (!rows.length) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of rows) {
      await client.query(
        `INSERT INTO dofus_items (id, name, level, type, img_url, data)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           level = EXCLUDED.level,
           type = EXCLUDED.type,
           img_url = EXCLUDED.img_url,
           data = EXCLUDED.data,
           "updatedAt" = now()`,
        [r.id, r.name, r.level, r.type, r.img_url, JSON.stringify(r.data)]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function fetchItemsPage(page) {
  const url = `https://api.dofusdb.fr/items?lang=fr&page=${page}&limit=${PAGE_SIZE}`;
  return await fetchJson(url);
}

async function scrapeLoop(typeFilter) {
  let page = 1;
  let total = Infinity;
  let consecutiveErrors = 0;
  const processedIds = new Set();

  while (page * PAGE_SIZE <= total + PAGE_SIZE) {
    scrapeState.page = page;

    // Récupère 6 pages en parallèle
    const pages = [];
    for (let i = 0; i < CONCURRENCY; i++) {
      const p = page + i;
      if (p * PAGE_SIZE <= total + PAGE_SIZE) pages.push(p);
    }
    if (!pages.length) break;

    const results = await Promise.allSettled(pages.map(p => fetchItemsPage(p)));

    let stop = false;
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value && Array.isArray(r.value.data)) {
        total = r.value.total || total;
        consecutiveErrors = 0;
        const rows = r.value.data.filter(i => !processedIds.has(i.id)).map(buildItemRow);
        rows.forEach(i => processedIds.add(i.id));
        if (rows.length) {
          await upsertItems(rows);
          scrapeState.done += rows.length;
        }
      } else {
        consecutiveErrors++;
        scrapeState.errors.push(`page ${r.status === 'rejected' ? '? ' + (r.reason && r.reason.message) : (r.value && r.value.status)}`);
        if (scrapeState.errors.length > 100) scrapeState.errors.shift();
      }
    }

    console.log(`📦 Scraping DofusDB… ${scrapeState.done}/${total} (page ${page})`);

    if (consecutiveErrors >= 10) {
      console.error('⚠️ Trop d\'erreurs consécutives, on stoppe le scraping. Relance via POST /api/items/scrape');
      break;
    }

    // Garde-fou : si la page retournée est vide, c'est fini
    const anyData = results.some(r => r.status === 'fulfilled' && r.value && Array.isArray(r.value.data) && r.value.data.length > 0);
    if (!anyData) break;

    page += CONCURRENCY;
    await new Promise(r => setTimeout(r, 250));
  }
}

async function startScrape(typeFilter) {
  if (scrapeState.running) return { error: 'Scraping déjà en cours' };
  scrapeState.running = true;
  scrapeState.total = 0;
  scrapeState.done = 0;
  scrapeState.page = 0;
  scrapeState.errors = [];
  scrapeState.typeFilter = typeFilter || null;

  // Lance le scraping en arrière-plan (ne bloque pas le serveur)
  (async () => {
    try {
      await scrapeLoop(scrapeState.typeFilter);
      console.log('✅ Scraping DofusDB terminé —', scrapeState.done, 'items en base');
    } catch (e) {
      scrapeState.errors.push(e.message);
      console.error('❌ Scraping interrompu:', e.message);
    } finally {
      scrapeState.running = false;
    }
  })();

  return { started: true };
}

async function searchLocalItems(q, limit = 20) {
  const { rows } = await pool.query(
    `SELECT id, name, level, type, img_url
     FROM dofus_items
     WHERE lower(name) LIKE $1
     ORDER BY level ASC
     LIMIT $2`,
    [`%${q.toLowerCase()}%`, limit]
  );
  return rows;
}

// ============================================================
//  CALCULATEUR RÉCURSIF DE FARM LIST
// ============================================================
async function computeFarmList(items) {
  const craftables = {};   // id -> {name, total, ingredients: {id: {name, totalQte}}}
  const brutes = {};       // id -> {name, total}
  const errors = [];

  for (const entry of items) {
    const { itemId, itemName, quantite } = entry;
    try {
      const recipe = await fetchRecipe(itemId);

      if (!recipe) {
        if (!brutes[itemId]) brutes[itemId] = { name: itemName, total: 0 };
        brutes[itemId].total += quantite;
        continue;
      }

      const ingredients = recipe.ingredients || [];
      if (!craftables[itemId]) craftables[itemId] = { name: itemName, total: 0, ingredients: {} };
      craftables[itemId].total += quantite;

      for (const ing of ingredients) {
        let qte = ing.quantity || 0;
        if (qte === 0 && recipe.quantities && recipe.ingredientIds) {
          const idx = recipe.ingredientIds.indexOf(ing.id);
          if (idx >= 0) qte = recipe.quantities[idx] || 0;
        }
        const cing = craftables[itemId].ingredients;
        if (!cing[ing.id]) cing[ing.id] = { name: getItemName(ing), totalQte: 0 };
        cing[ing.id].totalQte += qte * quantite;
      }
    } catch (e) {
      errors.push(`${itemName} (erreur API: ${e.message})`);
    }
    await new Promise(r => setTimeout(r, 100));
  }

  return { craftables, brutes, errors };
}

// ============================================================
//  EXPRESS
// ============================================================
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const asyncHandler = fn => (req, res) => fn(req, res).catch(e => res.status(500).json({ error: e.message }));

// ---------- Santé ----------
app.get('/api/health', asyncHandler(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok', database: 'postgres' });
}));

// ---------- Objectifs ----------
app.get('/api/objectifs', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM objectifs ORDER BY "createdAt" DESC, id DESC');
  res.json(rows);
}));

app.post('/api/objectifs', asyncHandler(async (req, res) => {
  const { titre, description = '', quantite = 1, deadline = null, statut = 'a_faire' } = req.body;
  const { rows } = await pool.query(
    'INSERT INTO objectifs (titre, description, quantite, deadline, statut) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [titre, description, quantite, deadline, statut]
  );
  res.json(rows[0]);
}));

app.put('/api/objectifs/:id', asyncHandler(async (req, res) => {
  const { titre, description, quantite, deadline, statut } = req.body;
  const { rows } = await pool.query(
    'UPDATE objectifs SET titre=$1, description=$2, quantite=$3, deadline=$4, statut=$5 WHERE id=$6 RETURNING *',
    [titre, description, quantite, deadline, statut, req.params.id]
  );
  res.json(rows[0]);
}));

app.delete('/api/objectifs/:id', asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM objectifs WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ---------- Prix HDV ----------
app.get('/api/prix', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM prix_hdv ORDER BY date DESC, id DESC');
  res.json(rows);
}));

app.post('/api/prix', asyncHandler(async (req, res) => {
  const { item_name, prix, quantite = 1, date = null } = req.body;
  const { rows } = await pool.query(
    'INSERT INTO prix_hdv (item_name, prix, quantite, date) VALUES ($1,$2,$3,$4) RETURNING *',
    [item_name, prix, quantite, date]
  );
  res.json(rows[0]);
}));

app.delete('/api/prix/:id', asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM prix_hdv WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ---------- Brouillons ----------
app.get('/api/brouillons', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM brouillons ORDER BY "updatedAt" DESC, id DESC');
  res.json(rows);
}));

app.post('/api/brouillons', asyncHandler(async (req, res) => {
  const { titre = 'Sans titre', contenu = '' } = req.body;
  const { rows } = await pool.query(
    'INSERT INTO brouillons (titre, contenu) VALUES ($1,$2) RETURNING *',
    [titre, contenu]
  );
  res.json(rows[0]);
}));

app.put('/api/brouillons/:id', asyncHandler(async (req, res) => {
  const { titre, contenu } = req.body;
  const { rows } = await pool.query(
    'UPDATE brouillons SET titre=$1, contenu=$2, "updatedAt"=now() WHERE id=$3 RETURNING *',
    [titre, contenu, req.params.id]
  );
  res.json(rows[0]);
}));

app.delete('/api/brouillons/:id', asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM brouillons WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ---------- Stuffs ----------
app.get('/api/stuffs', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM stuffs ORDER BY "createdAt" DESC, id DESC');
  res.json(rows.map(r => ({ ...r, items: JSON.parse(r.items || '[]') })));
}));

app.post('/api/stuffs', asyncHandler(async (req, res) => {
  const { nom, items = [], description = '' } = req.body;
  const { rows } = await pool.query(
    'INSERT INTO stuffs (nom, items, description) VALUES ($1,$2,$3) RETURNING *',
    [nom, JSON.stringify(items), description]
  );
  res.json({ ...rows[0], items: JSON.parse(rows[0].items || '[]') });
}));

app.put('/api/stuffs/:id', asyncHandler(async (req, res) => {
  const { nom, items, description } = req.body;
  const { rows } = await pool.query(
    'UPDATE stuffs SET nom=$1, items=$2, description=$3 WHERE id=$4 RETURNING *',
    [nom, JSON.stringify(items), description, req.params.id]
  );
  res.json({ ...rows[0], items: JSON.parse(rows[0].items || '[]') });
}));

app.delete('/api/stuffs/:id', asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM stuffs WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ---------- Farm Items ----------
app.get('/api/farm-items', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM farm_items ORDER BY "createdAt" DESC, id DESC');
  res.json(rows);
}));

app.post('/api/farm-items', asyncHandler(async (req, res) => {
  const { item_id, item_name, quantite } = req.body;
  const { rows } = await pool.query(
    'INSERT INTO farm_items (item_id, item_name, quantite) VALUES ($1,$2,$3) RETURNING *',
    [item_id, item_name, quantite]
  );
  res.json(rows[0]);
}));

app.put('/api/farm-items/:id', asyncHandler(async (req, res) => {
  const { item_id, item_name, quantite } = req.body;
  const { rows } = await pool.query(
    'UPDATE farm_items SET item_id=$1, item_name=$2, quantite=$3 WHERE id=$4 RETURNING *',
    [item_id, item_name, quantite, req.params.id]
  );
  res.json(rows[0]);
}));

app.delete('/api/farm-items/:id', asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM farm_items WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ---------- Inventaire ----------
app.get('/api/inventaire', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM inventaire ORDER BY item_name');
  res.json(rows);
}));

app.put('/api/inventaire', asyncHandler(async (req, res) => {
  const { item_name, quantite } = req.body;
  const { rows } = await pool.query(
    `INSERT INTO inventaire (item_name, quantite) VALUES ($1,$2)
     ON CONFLICT (item_name) DO UPDATE SET quantite=$2 RETURNING *`,
    [item_name, quantite]
  );
  res.json(rows[0]);
}));

app.delete('/api/inventaire/:id', asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM inventaire WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ---------- Attributions ----------
app.get('/api/attributions', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM attributions ORDER BY compte, personnage, item_name');
  res.json(rows);
}));

app.post('/api/attributions', asyncHandler(async (req, res) => {
  const { item_name, personnage, compte = '', quantite = 1, statut = 'a_farmer' } = req.body;
  const { rows } = await pool.query(
    'INSERT INTO attributions (item_name, personnage, compte, quantite, statut) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [item_name, personnage, compte, quantite, statut]
  );
  res.json(rows[0]);
}));

app.put('/api/attributions/:id', asyncHandler(async (req, res) => {
  const { item_name, personnage, compte, quantite, statut } = req.body;
  const { rows } = await pool.query(
    'UPDATE attributions SET item_name=$1, personnage=$2, compte=$3, quantite=$4, statut=$5 WHERE id=$6 RETURNING *',
    [item_name, personnage, compte, quantite, statut, req.params.id]
  );
  res.json(rows[0]);
}));

app.delete('/api/attributions/:id', asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM attributions WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ---------- Recherche DofusDB ----------
app.get('/api/search', asyncHandler(async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json([]);
  res.json(await searchDofusDB(q));
}));

// ---------- Scraping DofusDB ----------
app.get('/api/items/scrape', asyncHandler(async (req, res) => {
  res.json(scrapeState);
}));

app.post('/api/items/scrape', asyncHandler(async (req, res) => {
  const { type } = req.body || {};
  const r = await startScrape(type);
  if (r.error) return res.status(409).json({ error: r.error });
  res.json({ started: true, message: 'Scraping lancé en arrière-plan', ...scrapeState });
}));

app.get('/api/items', asyncHandler(async (req, res) => {
  const { q, limit = 30, page = 1 } = req.query;
  if (q) {
    return res.json(await searchLocalItems(q, Math.min(parseInt(limit) || 30, 100)));
  }
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const { rows } = await pool.query(
    `SELECT id, name, level, type, img_url FROM dofus_items
     ORDER BY name ASC LIMIT $1 OFFSET $2`,
    [parseInt(limit), offset]
  );
  res.json(rows);
}));

// ---------- Génération Farm List ----------
app.post('/api/generate-farm', asyncHandler(async (req, res) => {
  const { items, useInventory = true } = req.body;
  if (!items || !items.length) return res.json({ resources: [], errors: [] });

  const farmItems = items.map(i => ({
    itemId: i.item_id || i.id,
    itemName: i.item_name || i.name,
    quantite: i.quantite
  }));

  const { craftables, brutes, errors } = await computeFarmList(farmItems);

  const resourceTotals = {};
  const seen = new Set();

  function addResource(id, name, qte) {
    if (!resourceTotals[id]) resourceTotals[id] = { name, qte: 0 };
    resourceTotals[id].qte += qte;
  }

  async function decomposeCraftable(craftableId, multiplier) {
    if (seen.has(craftableId) || !craftables[craftableId]) return;
    seen.add(craftableId);

    const craft = craftables[craftableId];
    for (const [ingId, ing] of Object.entries(craft.ingredients)) {
      const totalQte = ing.totalQte * multiplier;
      if (craftables[ingId]) {
        await decomposeCraftable(ingId, totalQte / Math.max(1, craft.total));
      } else {
        addResource(ingId, ing.name, totalQte);
      }
    }
  }

  for (const craftableId of Object.keys(craftables)) {
    await decomposeCraftable(craftableId, 1);
  }

  for (const [id, info] of Object.entries(brutes)) {
    addResource(parseInt(id), info.name, info.total);
  }

  let stockMap = {};
  if (useInventory) {
    const { rows } = await pool.query('SELECT item_name, quantite FROM inventaire');
    rows.forEach(r => { stockMap[r.item_name.toLowerCase()] = r.quantite; });
  }

  const finalList = Object.entries(resourceTotals)
    .map(([id, info]) => {
      const total = Math.round(info.qte);
      const stock = stockMap[info.name.toLowerCase()] || 0;
      return { name: info.name, total, stock, toFarm: Math.max(0, total - stock) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  res.json({ resources: finalList, errors });
}));

// ---------- Démarrage ----------
initDb().then(async () => {
  app.listen(PORT, () => {
    console.log(`🚀 DofLib démarré sur le port ${PORT}`);
  });

  // Scraping automatique au premier démarrage (si la base d'items est vide)
  try {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM dofus_items');
    if (rows[0].count === 0) {
      console.log('🔄 Base d\'items vide → lancement du scraping DofusDB complet…');
      await startScrape(null);
    } else {
      console.log(`✅ ${rows[0].count} items déjà en base, scraping non nécessaire`);
    }
  } catch (e) {
    console.error('⚠️ Vérification items/sraping:', e.message);
  }
}).catch(e => {
  console.error('❌ Erreur de démarrage:', e.message);
  process.exit(1);
});
