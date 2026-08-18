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
    https.get(url, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
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
  const url = `https://api.dofusdb.fr/items?search[name]=${encodeURIComponent(query)}&lang=fr&limit=8`;
  const json = await fetchJson(url);
  return (json.data || []).map(i => {
    if (!itemCache.has(i.id)) {
      itemCache.set(i.id, { name: (i.name && i.name.fr) ? i.name.fr : 'Inconnu', level: i.level || 0 });
    }
    return {
      id: i.id,
      name: (i.name && i.name.fr) ? i.name.fr : 'Inconnu',
      level: i.level || 0
    };
  });
}

function getItemName(item) {
  if (item.name && item.name.fr) return item.name.fr;
  const cached = itemCache.get(item.id);
  return (cached && cached.name) || 'Inconnu';
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

// ---------- Recherche DofusDB ----------
app.get('/api/search', asyncHandler(async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json([]);
  res.json(await searchDofusDB(q));
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
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 DofLib démarré sur le port ${PORT}`);
  });
}).catch(e => {
  console.error('❌ Erreur de démarrage:', e.message);
  process.exit(1);
});