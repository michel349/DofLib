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
    img_url TEXT DEFAULT '',
    "createdAt" TIMESTAMPTZ DEFAULT now()
  );

  -- Tables créées avant l'ajout de img_url : on rajoute la colonne si absente
  ALTER TABLE farm_items ADD COLUMN IF NOT EXISTS img_url TEXT DEFAULT '';

  CREATE TABLE IF NOT EXISTS inventaire (
    id SERIAL PRIMARY KEY,
    item_name TEXT NOT NULL UNIQUE,
    quantite INTEGER DEFAULT 0
  );

  ALTER TABLE inventaire DROP COLUMN IF EXISTS img_url;

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
  ALTER TABLE attributions ADD COLUMN IF NOT EXISTS img_url TEXT DEFAULT '';

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

  -- Recettes de craft (ID du résultat, nom, niveau, ingrédients JSON)
  -- Permet de générer la farm list sans appeler l'API DofusDB à chaque fois
  CREATE TABLE IF NOT EXISTS dofus_recipes (
    result_id INTEGER PRIMARY KEY,
    result_name TEXT NOT NULL,
    result_level INTEGER DEFAULT 0,
    ingredients JSONB DEFAULT '[]',
    "updatedAt" TIMESTAMPTZ DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS idx_dofus_recipes_name ON dofus_recipes (lower(result_name));

  -- Farm lists sauvegardées : résultat de génération persisté (survit au reload)
  CREATE TABLE IF NOT EXISTS farm_lists (
    id SERIAL PRIMARY KEY,
    nom TEXT NOT NULL,
    items JSONB DEFAULT '[]',
    notes TEXT DEFAULT '',
    "createdAt" TIMESTAMPTZ DEFAULT now()
  );

  -- Paris : paris entre joueurs avec mises et gages
  CREATE TABLE IF NOT EXISTS paris (
    id SERIAL PRIMARY KEY,
    titre TEXT NOT NULL,
    description TEXT DEFAULT '',
    statut TEXT DEFAULT 'en_cours' CHECK (statut IN ('en_cours','termine')),
    gagnant TEXT DEFAULT '',
    "createdAt" TIMESTAMPTZ DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS paris_joueurs (
    id SERIAL PRIMARY KEY,
    pari_id INTEGER NOT NULL REFERENCES paris(id) ON DELETE CASCADE,
    nom TEXT NOT NULL,
    mise TEXT DEFAULT '',
    gage TEXT DEFAULT '',
    "createdAt" TIMESTAMPTZ DEFAULT now()
  );

  -- Compteur Harebourg : nombre de donjons effectués + bandelettes lootées
  CREATE TABLE IF NOT EXISTS harebourg_stats (
    id INTEGER PRIMARY KEY,
    donjons INTEGER DEFAULT 0,
    bandelettes INTEGER DEFAULT 0,
    "updatedAt" TIMESTAMPTZ DEFAULT now()
  );

  INSERT INTO harebourg_stats (id, donjons, bandelettes)
  VALUES (1, 0, 0)
  ON CONFLICT (id) DO NOTHING;
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

// ============ PiP Harebourg ============
let harebourgPipWindow = null;

function harebourgPipSupported() {
  return 'documentPictureInPicture' in window;
}

function copyStylesTo(target) {
  for (const sheet of document.styleSheets) {
    try {
      const css = [...sheet.cssRules].map(r => r.cssText).join('\n');
      const style = target.document.createElement('style');
      style.textContent = css;
      target.document.head.appendChild(style);
    } catch (e) {
      if (sheet.href) {
        const link = target.document.createElement('link');
        link.rel = 'stylesheet';
        link.href = sheet.href;
        target.document.head.appendChild(link);
      }
    }
  }
}

async function toggleHarebourgPip() {
  const content     = document.getElementById('harebourgPipContent');
  const placeholder = document.getElementById('harebourgPipPlaceholder');
  const btn         = document.getElementById('harebourgPipBtn');

  // déjà ouverte → on ferme
  if (harebourgPipWindow) { harebourgPipWindow.close(); return; }

  harebourgPipWindow = await documentPictureInPicture.requestWindow({
    width: 300,
    height: 210,
  });

  copyStylesTo(harebourgPipWindow);

  // Récupère les variables CSS du thème (var(--text), var(--yellow)...)
  const rootStyle = getComputedStyle(document.documentElement);
  const vars = ['--text', '--yellow', '--bg', '--card', '--muted', '--border'];
  const inline = vars
    .map(v => `${v}:${rootStyle.getPropertyValue(v)}`)
    .filter(s => s.split(':')[1].trim())
    .join(';');
  harebourgPipWindow.document.documentElement.setAttribute('style', inline);

  harebourgPipWindow.document.body.classList.add('hb-pip-mode');
  harebourgPipWindow.document.body.append(content);

  btn.textContent = '↩ Rattacher';

  harebourgPipWindow.addEventListener('pagehide', () => {
    placeholder.after(content);
    btn.textContent = '📌 Détacher';
    harebourgPipWindow = null;
  });
}

// Affiche le bouton uniquement si supporté
document.addEventListener('DOMContentLoaded', () => {
  if (harebourgPipSupported()) {
    document.getElementById('harebourgPipBtn').hidden = false;
  }
});

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
  // 1) Base locale d'abord (table dofus_recipes)
  try {
    const { rows } = await pool.query(
      'SELECT result_name, result_level, ingredients FROM dofus_recipes WHERE result_id = $1',
      [itemId]
    );
    if (rows.length) {
      const ing = rows[0].ingredients || [];
      // Recette invalide si elle a des ingrédients mais tous à quantity 0
      // (scraping qui n'a pas récupéré les quantités) → fallback API directe
      if (ing.length && !ing.some(x => (x.quantity || 0) > 0)) {
        throw new Error('quantities_invalides');
      }
      return {
        id: itemId,
        resultId: itemId,
        resultName: { fr: rows[0].result_name },
        resultLevel: rows[0].result_level,
        ingredients: ing.map(x => ({ id: x.id, quantity: x.quantity || 0, name: x.name }))
      };
    }
  } catch (e) { /* table pas encore créée, vide, ou quantités invalides → API directe */ }

  // 2) Cache mémoire
  const cached = itemCache.get(itemId);
  if (cached && cached.recipe) return cached.recipe;

  // 3) Fallback API en direct — normalise la recette (quantités depuis
  //    `quantities[]` indexé par `ingredientIds[]`) et la stocke en BDD
  //    pour ne pas rappeler l'API à chaque génération.
  const json = await fetchJson(`https://api.dofusdb.fr/recipes?resultId=${itemId}`);
  const raw = (json.data && json.data[0]) || null;
  if (!raw) {
    const entryNull = itemCache.get(itemId) || {};
    entryNull.recipe = null;
    itemCache.set(itemId, entryNull);
    return null;
  }

  const ings = Array.isArray(raw.ingredients) ? raw.ingredients : [];
  const ingredientIds = Array.isArray(raw.ingredientIds) ? raw.ingredientIds : [];
  const quantities = Array.isArray(raw.quantities) ? raw.quantities : [];
  const frName = recipeName(raw);
  const recipe = {
    id: itemId,
    resultId: itemId,
    resultName: { fr: frName },
    resultLevel: raw.resultLevel || 0,
    ingredients: ings.map(x => {
      const n = x.name;
      let ingName = '';
      if (typeof n === 'string') ingName = n;
      else if (n && (n.fr || n.en)) ingName = n.fr || n.en;
      let quantity = x.quantity || 0;
      // Même fallback que buildRecipeRow : les quantités sont souvent dans
      // un tableau séparé `quantities[]` indexé par `ingredientIds[]`.
      if (quantity === 0 && ingredientIds.length && quantities.length) {
        const idx = ingredientIds.indexOf(x.id);
        if (idx >= 0) quantity = quantities[idx] || 0;
      }
      return { id: x.id, quantity, name: { fr: ingName } };
    })
  };

  // Met à jour la BDD pour les prochaines requêtes (évite de rappeler l'API)
  try {
    await pool.query(
      `INSERT INTO dofus_recipes (result_id, result_name, result_level, ingredients)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (result_id) DO UPDATE SET
         result_name = EXCLUDED.result_name,
         result_level = EXCLUDED.result_level,
         ingredients = EXCLUDED.ingredients,
         "updatedAt" = now()`,
      [recipe.resultId, recipe.resultName.fr, recipe.resultLevel, JSON.stringify(recipe.ingredients)]
    );
  } catch (e) { /* table pas encore créée */ }

  const entry = itemCache.get(itemId) || {};
  entry.recipe = recipe;
  itemCache.set(itemId, entry);
  return recipe;
}

// ---------- Recherche multi-filtres ----------
// Une catégorie "type" peut être un vrai type (ex: "Ressource") ou
// un filtre spécial : "craftable" (items avec recette) / "recette" (items dans dofus_recipes)
const SPECIAL_TYPES = ['craftable', 'recette'];

function parseTypes(value) {
  // Accepte une string ou un array (query params répétés type=A&type=B)
  if (!value) return [];
  const arr = Array.isArray(value) ? value : [value];
  return [...new Set(arr.filter(Boolean))];
}

async function searchRecipesLocal(q, limit = 20, types = []) {
  // Recherche dans les recettes de craft scrappées (table dofus_recipes)
  // Enrichie avec l'image et le vrai type depuis dofus_items (si disponible)
  // Si des types sont précisés, on filtre pour ne mélanger que des items des mêmes types
  const wantsRecettes = !types.length || types.includes('recette') || types.includes('craftable');

  if (!wantsRecettes) return [];

  let query = `SELECT r.result_id AS id, r.result_name AS name, r.result_level AS level,
            COALESCE(i.img_url, '') AS img_url,
            COALESCE(i.type, '') AS type
     FROM dofus_recipes r
     LEFT JOIN dofus_items i ON i.id = r.result_id
     WHERE lower(r.result_name) LIKE $1`;
  const params = [`%${q.toLowerCase()}%`];

  const realTypes = types.filter(t => !SPECIAL_TYPES.includes(t));
  if (realTypes.length) {
    const placeholders = realTypes.map((_, i) => '$' + (params.length + 1 + i)).join(',');
    query += ` AND i.type IN (${placeholders})`;
    params.push(...realTypes);
  }

  query += ` ORDER BY r.result_level ASC LIMIT $${params.length + 1}`;
  params.push(limit);

  const { rows } = await pool.query(query, params);
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    level: r.level,
    type: r.type || 'Recette',
    img_url: r.img_url || ''
  }));
}

async function searchLocalItems(q, limit = 20, types = []) {
  const params = [`%${q.toLowerCase()}%`];
  let typeFilter = '';

  const wantsAll = !types.length;
  const wantsCraftable = types.includes('craftable');
  const wantsRecette = types.includes('recette');

  // Filtres particuliers
  if (wantsCraftable || wantsRecette) {
    // Si un filtre spécial est actif, on ne prend QUE les items avec recette
    typeFilter = ` AND EXISTS (
       SELECT 1 FROM dofus_recipes rc WHERE rc.result_id = dofus_items.id
     )`;
  }

  // Filtres par types réels (Ressource, Arme, etc.)
  if (wantsAll) {
    // Aucun filtre : exclut seulement les non-items
    params.push(...NON_ITEM_TYPES);
    typeFilter += ` AND (type = '' OR type NOT IN (${NON_ITEM_TYPES.map((_, i) => '$' + (params.length - NON_ITEM_TYPES.length + i + 1)).join(',')}))`;
  } else {
    const realTypes = types.filter(t => !SPECIAL_TYPES.includes(t));
    if (realTypes.length) {
      const placeholders = realTypes.map((_, i) => '$' + (params.length + 1 + i)).join(',');
      typeFilter += ` AND type IN (${placeholders})`;
      params.push(...realTypes);
    } else if (wantsCraftable || wantsRecette) {
      // Aucun type réel : on garde tout (le filtre craftable gère déjà)
    } else {
      // Cas ne devrait pas arriver
      params.push(...NON_ITEM_TYPES);
      typeFilter += ` AND (type = '' OR type NOT IN (${NON_ITEM_TYPES.map((_, i) => '$' + (params.length - NON_ITEM_TYPES.length + i + 1)).join(',')}))`;
    }
  }

  params.push(limit);
  const { rows } = await pool.query(
    `SELECT id, name, level, type, img_url
     FROM dofus_items
     WHERE lower(name) LIKE $1
       ${typeFilter}
     ORDER BY CASE
       WHEN type IN ('Équipement','Equipement','Arme','Bouclier','Trophée') THEN 0
       WHEN type IN ('Consommable','Parcho') THEN 1
       WHEN type = 'Ressource' THEN 2
       ELSE 3 END,
       level ASC
     LIMIT $${params.length}`,
    params
  );
  return rows;
}

async function searchDofusDB(query, types = [], limit = 50) {
  // 1) Recherche en parallèle : items locaux + recettes de craft
  const [local, recettes] = await Promise.all([
    searchLocalItems(query, limit, types),
    searchRecipesLocal(query, limit * 2, types)
  ]);

  // 2) Fusion : priorité aux items craftables (présents dans dofus_recipes),
  //    puis aux équipements, puis par niveau croissant.
  const seen = new Set();
  const merged = [];

  // Les recettes d'abord — ce sont les items à crafter
  for (const r of recettes) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    merged.push({ ...r, craftable: true });
  }

  // Ensuite les items locaux restants (ressources, consommables…)
  for (const r of local) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    merged.push({ ...r });
  }

  // Tri intelligent : craftable > équipement/arme/bouclier > niveau
  merged.sort((a, b) => {
    const craftA = a.craftable ? 1 : 0;
    const craftB = b.craftable ? 1 : 0;
    if (craftA !== craftB) return craftB - craftA;
    const eqA = /(équip|equip|arme|bouclier)/i.test(a.type || '') ? 1 : 0;
    const eqB = /(équip|equip|arme|bouclier)/i.test(b.type || '') ? 1 : 0;
    if (eqA !== eqB) return eqB - eqA;
    return (a.level || 0) - (b.level || 0);
  });

  if (merged.length > 0) return merged.slice(0, limit);

  // 3) Fallback API en direct (si base items ET recettes sont vides)
  try {
    const url = `https://api.dofusdb.fr/items?search[name]=${encodeURIComponent(query)}&lang=fr&$limit=12`;
    const json = await fetchJson(url);
    return (json.data || [])
      .filter(i => {
        // Ne remonte pas les monstres/sorts/montures de l'API
        const t = itemTypeName(i);
        return !isNonItemType(t);
      })
      .map(i => {
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

// Un item est "utile" si son type n'est pas un non-item (monstre, sort, etc.)
// et s'il a un nom exploitable.
function isUsefulItem(i) {
  const type = itemTypeName(i);
  if (isNonItemType(type)) return false;
  const names = i.name || {};
  const name = names.fr || names.en || names.de || '';
  return name !== '' && name !== 'Inconnu';
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

async function fetchItemsPage(skip, typeFilter = null) {
  // L'API DofusDB utilise $limit/$skip (comme le script Google Sheets),
  // PAS page/limit — c'est pour ça que le scraping renvoyait 0 item.
  // $sort=id est indispensable : sans tri stable, la pagination $skip
  // peut sauter des items (surtout les équipements bas niveau comme Padgref)
  // et le scraping s'arrête avant de les atteindre.
  let url = `https://api.dofusdb.fr/items?lang=fr&$limit=${PAGE_SIZE}&$skip=${skip}&$sort=id`;
  if (typeFilter) {
    url += `&type.name.fr=${encodeURIComponent(typeFilter)}`;
  }
  return await fetchJson(url);
}

async function scrapeLoop(typeFilter) {
  let skip = 0;
  let total = Infinity;
  let consecutiveErrors = 0;
  const processedIds = new Set();

  // Reprise automatique : charge les IDs déjà en base pour ne pas les retélécharger
  // (utile quand Railway redémarre le conteneur en plein scraping)
  try {
    const { rows } = await pool.query('SELECT id FROM dofus_items');
    rows.forEach(r => processedIds.add(r.id));
    if (processedIds.size > 0) {
      console.log(`♻️ Reprise du scraping : ${processedIds.size} items déjà en base, on continue…`);
    }
  } catch (e) { /* table vide ou pas encore créée */ }

  while (skip < total) {
    scrapeState.page = Math.floor(skip / PAGE_SIZE) + 1;

    // Récupère plusieurs tranches en parallèle
    const skips = [];
    for (let i = 0; i < CONCURRENCY; i++) {
      const s = skip + i * PAGE_SIZE;
      if (s < total) skips.push(s);
    }
    if (!skips.length) break;

    const results = await Promise.allSettled(skips.map(s => fetchItemsPage(s, typeFilter)));

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value && Array.isArray(r.value.data)) {
        total = r.value.total || total;
        consecutiveErrors = 0;
        const rows = r.value.data.filter(i => !processedIds.has(i.id) && isUsefulItem(i)).map(buildItemRow);
        rows.forEach(i => processedIds.add(i.id));
        if (rows.length) {
          await upsertItems(rows);
          scrapeState.done += rows.length;
        }
      } else {
        consecutiveErrors++;
        scrapeState.errors.push(`skip ${r.status === 'rejected' ? '? ' + (r.reason && r.reason.message) : (r.value && r.value.status)}`);
        if (scrapeState.errors.length > 100) scrapeState.errors.shift();
      }
    }

    console.log(`📦 Scraping DofusDB… ${scrapeState.done}/${total} (skip ${skip})`);

    if (consecutiveErrors >= 10) {
      console.error('⚠️ Trop d\'erreurs consécutives, on stoppe le scraping. Relance via POST /api/items/scrape');
      break;
    }

    // Garde-fou : si la tranche retournée est vide, c'est fini
    const anyData = results.some(r => r.status === 'fulfilled' && r.value && Array.isArray(r.value.data) && r.value.data.length > 0);
    if (!anyData) break;

    skip += CONCURRENCY * PAGE_SIZE;
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

// Types DofusDB qui ne sont PAS des items craftables/farmables
// (monstres, montures, sorts, etc.) — à exclure de la recherche,
// du scraping ET à supprimer lors du nettoyage de la base.
const NON_ITEM_TYPES = [
  // Français
  'Monstre', 'Monture', 'Sort', 'Sort passif', 'Alignement', 'Défi',
  'Zone de combat', 'Cérémonie', 'Célébration', 'Mutation', 'Bénédiction',
  'Malédiction', 'Boost', 'État',
  // Équivalents anglais DofusDB
  'Monster', 'Mount', 'Spell', 'Passive spell', 'Alignment', 'Challenge',
  'Battle zone', 'Ceremony', 'Celebration', 'Blessing', 'Curse', 'State',
  // Types non-farmables supplémentaires
  'Compagnon', 'Companion', 'Dopeul', 'Crâ', 'Protecteur', 'Protector',
  'Bonta', 'Brakmar', 'Orbe', 'Emote', 'PNJ', 'NPC'
];

// Vérifie si un type d'item est un "non-item" (monstre, sort, etc.)
function isNonItemType(type) {
  if (!type) return false;
  const t = String(type).toLowerCase().trim();
  return NON_ITEM_TYPES.some(x => x.toLowerCase() === t);
}

// Résout l'id et l'image d'un item à partir de son nom (table dofus_items)
async function resolveItemMeta(name) {
  if (!name) return {};
  try {
    const { rows } = await pool.query(
      `SELECT id, name, img_url FROM dofus_items
       WHERE lower(name) = lower($1) LIMIT 1`,
      [name]
    );
    if (rows.length) return { id: rows[0].id, name: rows[0].name, img_url: rows[0].img_url || '' };
    const { rows: r2 } = await pool.query(
      `SELECT id, name, img_url FROM dofus_items
       WHERE lower(name) LIKE lower($1) LIMIT 1`,
      ['%' + name + '%']
    );
    if (r2.length) return { id: r2[0].id, name: r2[0].name, img_url: r2[0].img_url || '' };
  } catch (e) { /* ignore */ }
  return {};
}

// ============================================================
//  SCRAPING RECETTES DOFUSDB → POSTGRES
//  Réplique le script Google Sheets ACTUALISER_DB_ITEMS :
//  aspire l'endpoint /recipes avec pagination $limit/$skip.
//  Rapide et léger (~15 000 recettes max).
// ============================================================
const scrapeRecipesState = {
  running: false,
  total: 0,
  done: 0,
  skip: 0,
  errors: []
};

const RECIPES_LIMIT = 50;   // comme le script : $limit=50

function recipeName(r) {
  const n = r.resultName || r.name || {};
  if (typeof n === 'string') return n;
  return n.fr || n.en || n.de || 'Inconnu';
}

function buildRecipeRow(r) {
  const ings = Array.isArray(r.ingredients) ? r.ingredients : [];
  const ingredientIds = Array.isArray(r.ingredientIds) ? r.ingredientIds : [];
  const quantities = Array.isArray(r.quantities) ? r.quantities : [];
  return {
    result_id: r.resultId,
    result_name: recipeName(r),
    result_level: r.resultLevel || 0,
    ingredients: ings.map(x => {
      const n = x.name;
      let frName = '';
      if (typeof n === 'string') frName = n;
      else if (n && (n.fr || n.en)) frName = n.fr || n.en;
      let quantity = x.quantity || 0;
      // L'API DofusDB renvoie souvent les quantités dans un tableau séparé
      // `quantities[]` indexé par `ingredientIds[]` (pas sur chaque ingrédient).
      // Sans ce fallback, toutes les quantités stockées en BDD seraient 0.
      if (quantity === 0 && ingredientIds.length && quantities.length) {
        const idx = ingredientIds.indexOf(x.id);
        if (idx >= 0) quantity = quantities[idx] || 0;
      }
      return { id: x.id, quantity, name: { fr: frName } };
    })
  };
}

async function upsertRecipes(rows) {
  if (!rows.length) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of rows) {
      await client.query(
        `INSERT INTO dofus_recipes (result_id, result_name, result_level, ingredients)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (result_id) DO UPDATE SET
           result_name = EXCLUDED.result_name,
           result_level = EXCLUDED.result_level,
           ingredients = EXCLUDED.ingredients,
           "updatedAt" = now()`,
        [r.result_id, r.result_name, r.result_level, JSON.stringify(r.ingredients)]
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

async function fetchRecipesPage(skip) {
  const url = `https://api.dofusdb.fr/recipes?$limit=${RECIPES_LIMIT}&$skip=${skip}&$sort=resultId`;
  return await fetchJson(url);
}

async function scrapeRecipesLoop() {
  let skip = 0;
  let total = Infinity;
  let consecutiveErrors = 0;

  while (skip < total) {
    scrapeRecipesState.skip = skip;
    try {
      const json = await fetchRecipesPage(skip);
      const data = json.data || json;
      if (!data || !data.length) break;

      total = json.total || data.length;
      await upsertRecipes(data.map(buildRecipeRow));
      scrapeRecipesState.done += data.length;
      consecutiveErrors = 0;
      console.log(`📜 Recettes DofusDB… ${scrapeRecipesState.done}/${total} (skip ${skip})`);
    } catch (e) {
      consecutiveErrors++;
      scrapeRecipesState.errors.push(`skip ${skip}: ${e.message}`);
      if (scrapeRecipesState.errors.length > 100) scrapeRecipesState.errors.shift();
      if (consecutiveErrors >= 10) {
        console.error('⚠️ Trop d\'erreurs recettes, on stoppe. Relance via POST /api/recipes/scrape');
        break;
      }
    }
    skip += RECIPES_LIMIT;
    await new Promise(r => setTimeout(r, 150));
  }
}

async function startRecipesScrape() {
  if (scrapeRecipesState.running) return { error: 'Scraping recettes déjà en cours' };
  scrapeRecipesState.running = true;
  scrapeRecipesState.total = 0;
  scrapeRecipesState.done = 0;
  scrapeRecipesState.skip = 0;
  scrapeRecipesState.errors = [];

  // Lance en arrière-plan (ne bloque pas le serveur)
  (async () => {
    try {
      await scrapeRecipesLoop();
      console.log('✅ Scraping recettes terminé —', scrapeRecipesState.done, 'recettes en base');
    } catch (e) {
      scrapeRecipesState.errors.push(e.message);
      console.error('❌ Scraping recettes interrompu:', e.message);
    } finally {
      scrapeRecipesState.running = false;
    }
  })();

  return { started: true };
}

// ============================================================
//  CALCULATEUR RÉCURSIF DE FARM LIST
// ============================================================
async function computeFarmList(items) {
  // crafts[id] = { name, total: demande directe, qtyPerUnit: { ingId: qty } }
  const crafts = {};
  // recipes[id] = recette complète (ou null si l'item n'a pas de recette)
  // Charge RÉCURSIVEMENT les recettes des ingrédients imbriqués :
  // ex. Équipement → Rune (craftable) → Ressource brute.
  const recipes = new Map();
  const brutes = {};
  const errors = [];
  const loading = new Set();
  // id → nom français de tous les ingrédients rencontrés (bruts ET craftables)
  const ingredientNames = new Map();

  async function ensureRecipeTree(itemId, itemName) {
    if (recipes.has(itemId) || loading.has(itemId)) return;
    loading.add(itemId);
    try {
      const recipe = await fetchRecipe(itemId);
      recipes.set(itemId, recipe);
      if (recipe) {
        for (const ing of recipe.ingredients || []) {
          ingredientNames.set(ing.id, getItemName(ing));
          await ensureRecipeTree(ing.id, getItemName(ing));
        }
      }
    } catch (e) {
      errors.push(`${itemName} (erreur API: ${e.message})`);
      recipes.set(itemId, null);
    }
    await new Promise(r => setTimeout(r, 100));
  }

  for (const entry of items) {
    const { itemId, itemName, quantite } = entry;

    // Charge la recette de l'item (et toutes ses sous-recettes)
    await ensureRecipeTree(itemId, itemName);
    const recipe = recipes.get(itemId);

    if (!recipe) {
      if (!brutes[itemId]) brutes[itemId] = { name: itemName, total: 0 };
      brutes[itemId].total += quantite;
      continue;
    }

    if (!crafts[itemId]) crafts[itemId] = { name: itemName, total: 0, qtyPerUnit: {} };
    crafts[itemId].total += quantite;
  }

  // Construit qtyPerUnit pour TOUS les craftables présents dans l'arbre
  // de recettes (demandés ET imbriqués). Les imbriqués non demandés
  // ontt total = 0 mais leur qtyPerUnit sera utilisé lors de la décomposition.
  for (const [id, recipe] of recipes) {
    if (!recipe) continue;
    const cid = typeof id === 'string' ? parseInt(id) : id;
    if (!crafts[cid]) {
      const rn = recipe.resultName;
      crafts[cid] = {
        name: (rn && rn.fr) ? rn.fr : (typeof rn === 'string' ? rn : 'Inconnu'),
        total: 0,
        qtyPerUnit: {}
      };
    }
    for (const ing of recipe.ingredients || []) {
      let qte = ing.quantity || 0;
      if (qte === 0 && recipe.quantities && recipe.ingredientIds) {
        const idx = recipe.ingredientIds.indexOf(ing.id);
        if (idx >= 0) qte = recipe.quantities[idx] || 0;
      }
      crafts[cid].qtyPerUnit[ing.id] = qte;
    }
  }

  return { crafts, recipes, brutes, errors, ingredientNames };
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
  const meta = await resolveItemMeta(item_name);
  const img_url = req.body.img_url || meta.img_url || '';
  const { rows } = await pool.query(
    'INSERT INTO farm_items (item_id, item_name, quantite, img_url) VALUES ($1,$2,$3,$4) RETURNING *',
    [item_id, item_name, quantite, img_url || null]
  );
  res.json(rows[0]);
}));

app.put('/api/farm-items/:id', asyncHandler(async (req, res) => {
  const { item_id, item_name, quantite } = req.body;
  const meta = await resolveItemMeta(item_name);
  const img_url = req.body.img_url || meta.img_url || '';
  const { rows } = await pool.query(
    'UPDATE farm_items SET item_id=$1, item_name=$2, quantite=$3, img_url=$4 WHERE id=$5 RETURNING *',
    [item_id, item_name, quantite, img_url || null, req.params.id]
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

// Ajoute (incrémente) une quantité à un item d'inventaire existant ou le crée
app.post('/api/inventaire/add', asyncHandler(async (req, res) => {
  const { item_name, quantite = 1 } = req.body;
  const { rows } = await pool.query(
    `INSERT INTO inventaire (item_name, quantite) VALUES ($1,$2)
     ON CONFLICT (item_name) DO UPDATE SET quantite = inventaire.quantite + $2 RETURNING *`,
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
  const meta = await resolveItemMeta(item_name);
  const img_url = req.body.img_url || meta.img_url || '';
  const { rows } = await pool.query(
    'INSERT INTO attributions (item_name, personnage, compte, quantite, statut, img_url) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [item_name, personnage, compte, quantite, statut, img_url || null]
  );
  res.json(rows[0]);
}));

app.put('/api/attributions/:id', asyncHandler(async (req, res) => {
  const { item_name, personnage, compte, quantite, statut } = req.body;
  const meta = await resolveItemMeta(item_name);
  const img_url = req.body.img_url || meta.img_url || '';
  const { rows } = await pool.query(
    'UPDATE attributions SET item_name=$1, personnage=$2, compte=$3, quantite=$4, statut=$5, img_url=$6 WHERE id=$7 RETURNING *',
    [item_name, personnage, compte, quantite, statut, img_url || null, req.params.id]
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
  // Supporte les filtres multiples : ?type=Ressource&type=Arme ou ?type=craftable
  const types = parseTypes(req.query.type);
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  res.json(await searchDofusDB(q, types, limit));
}));

// Liste des types d'items présents en base (pour le filtre de la palette)
app.get('/api/item-types', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT type, COUNT(*)::int AS count
     FROM dofus_items
     WHERE type != ''
       AND type NOT IN (${NON_ITEM_TYPES.map((_, i) => '$' + (i + 1)).join(',')})
     GROUP BY type
     ORDER BY count DESC`,
    NON_ITEM_TYPES
  );
  // Ajoute les filtres spéciaux craftable/recette en plus des types
  res.json([
    { type: 'craftable', count: await countCraftables(), special: true },
    { type: 'recette', count: await countRecettes(), special: true },
    ...rows
  ]);
}));

async function countCraftables() {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(DISTINCT r.result_id)::int AS count
       FROM dofus_recipes r
       JOIN dofus_items i ON i.id = r.result_id
       WHERE i.type != ''
         AND i.type NOT IN (${NON_ITEM_TYPES.map((_, i) => '$' + (i + 1)).join(',')})`,
      NON_ITEM_TYPES
    );
    return rows[0].count || 0;
  } catch (e) { return 0; }
}

async function countRecettes() {
  try {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM dofus_recipes');
    return rows[0].count || 0;
  } catch (e) { return 0; }
}

// ---------- Statistiques & Nettoyage de la base items ----------
app.get('/api/items/stats', asyncHandler(async (req, res) => {
  const n = NON_ITEM_TYPES.length;
  const inParams = NON_ITEM_TYPES.map((_, i) => '$' + (i + 1)).join(',');
  const notInParams = NON_ITEM_TYPES.map((_, i) => '$' + (i + 1 + n)).join(',');
  const { rows } = await pool.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE type = '' OR type IS NULL)::int AS sans_type,
       COUNT(*) FILTER (WHERE lower(type) IN (${inParams}))::int AS non_utiles,
       COUNT(*) FILTER (WHERE lower(type) NOT IN (${notInParams}) AND type != '')::int AS utiles
     FROM dofus_items`,
    [...NON_ITEM_TYPES, ...NON_ITEM_TYPES]
  );
  const byType = await pool.query(
    `SELECT type, COUNT(*)::int AS count
     FROM dofus_items
     WHERE type != ''
     GROUP BY type
     ORDER BY count DESC
     LIMIT 30`
  );
  res.json({ ...rows[0], byType: byType.rows });
}));

// Nettoyage : supprime les non-items (monstres, sorts, montures…) déjà en base
app.post('/api/items/clean', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `DELETE FROM dofus_items
     WHERE type = ''
        OR lower(type) IN (${NON_ITEM_TYPES.map((_, i) => '$' + (i + 1)).join(',')})
     RETURNING id`,
    NON_ITEM_TYPES
  );
  // Recalcule aussi les items restants dans le cache mémoire
  itemCache.clear();
  res.json({ deleted: rows.length, message: `${rows.length} items non-utiles supprimés` });
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

// ---------- Scraping Recettes DofusDB ----------
app.get('/api/recipes/scrape', asyncHandler(async (req, res) => {
  res.json(scrapeRecipesState);
}));

app.post('/api/recipes/scrape', asyncHandler(async (req, res) => {
  const r = await startRecipesScrape();
  if (r.error) return res.status(409).json({ error: r.error });
  res.json({ started: true, message: 'Scraping recettes lancé en arrière-plan', ...scrapeRecipesState });
}));

app.get('/api/recipes', asyncHandler(async (req, res) => {
  const { limit = 30, page = 1 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const { rows } = await pool.query(
    `SELECT result_id, result_name, result_level FROM dofus_recipes
     ORDER BY result_name ASC LIMIT $1 OFFSET $2`,
    [parseInt(limit), offset]
  );
  res.json(rows);
}));

// ---------- Farm Lists sauvegardées ----------
app.get('/api/farm-lists', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM farm_lists ORDER BY "createdAt" DESC, id DESC');
  res.json(rows.map(r => ({ ...r, items: r.items || [] })));
}));

app.post('/api/farm-lists', asyncHandler(async (req, res) => {
  const { nom, items = [], notes = '' } = req.body;
  const { rows } = await pool.query(
    'INSERT INTO farm_lists (nom, items, notes) VALUES ($1,$2,$3) RETURNING *',
    [nom, JSON.stringify(items), notes]
  );
  res.json({ ...rows[0], items: rows[0].items || [] });
}));

app.put('/api/farm-lists/:id', asyncHandler(async (req, res) => {
  const { nom, items, notes } = req.body;
  const { rows } = await pool.query(
    'UPDATE farm_lists SET nom=$1, items=$2, notes=$3 WHERE id=$4 RETURNING *',
    [nom, JSON.stringify(items), notes, req.params.id]
  );
  res.json({ ...rows[0], items: rows[0].items || [] });
}));

app.delete('/api/farm-lists/:id', asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM farm_lists WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ---------- Paris ----------
// Récupère un pari avec ses joueurs
async function getPariWithJoueurs(id) {
  const { rows } = await pool.query(
    `SELECT p.*,
       COALESCE(json_agg(
         json_build_object('id', j.id, 'nom', j.nom, 'mise', j.mise, 'gage', j.gage, 'createdAt', j."createdAt")
         ORDER BY j.id
       ) FILTER (WHERE j.id IS NOT NULL), '[]') AS joueurs
     FROM paris p
     LEFT JOIN paris_joueurs j ON j.pari_id = p.id
     WHERE p.id = $1
     GROUP BY p.id`,
    [id]
  );
  return rows[0] || null;
}

// Récupère tous les paris avec leurs joueurs
async function getAllParis() {
  const { rows } = await pool.query(
    `SELECT p.*,
       COALESCE(json_agg(
         json_build_object('id', j.id, 'nom', j.nom, 'mise', j.mise, 'gage', j.gage, 'createdAt', j."createdAt")
         ORDER BY j.id
       ) FILTER (WHERE j.id IS NOT NULL), '[]') AS joueurs
     FROM paris p
     LEFT JOIN paris_joueurs j ON j.pari_id = p.id
     GROUP BY p.id
     ORDER BY
       CASE WHEN p.statut = 'en_cours' THEN 0 ELSE 1 END,
       p."createdAt" DESC`
  );
  return rows;
}

app.get('/api/paris', asyncHandler(async (req, res) => {
  res.json(await getAllParis());
}));

app.get('/api/paris/:id', asyncHandler(async (req, res) => {
  const pari = await getPariWithJoueurs(req.params.id);
  if (!pari) return res.status(404).json({ error: 'Pari introuvable' });
  res.json(pari);
}));

app.post('/api/paris', asyncHandler(async (req, res) => {
  const { titre, description = '' } = req.body;
  if (!titre || !titre.trim()) return res.status(400).json({ error: 'Un titre est requis' });
  const { rows } = await pool.query(
    'INSERT INTO paris (titre, description) VALUES ($1,$2) RETURNING *',
    [titre.trim(), description]
  );
  res.json({ ...rows[0], joueurs: [] });
}));

app.put('/api/paris/:id', asyncHandler(async (req, res) => {
  const { titre, description, statut, gagnant } = req.body;
  let query = 'UPDATE paris SET ';
  const sets = [];
  const params = [];
  if (titre !== undefined) { params.push(titre); sets.push(`titre = $${params.length}`); }
  if (description !== undefined) { params.push(description); sets.push(`description = $${params.length}`); }
  if (statut !== undefined) { params.push(statut); sets.push(`statut = $${params.length}`); }
  if (gagnant !== undefined) { params.push(gagnant); sets.push(`gagnant = $${params.length}`); }
  if (!sets.length) return res.status(400).json({ error: 'Aucun champ à mettre à jour' });
  params.push(req.params.id);
  query += sets.join(', ') + ` WHERE id = $${params.length} RETURNING *`;
  const { rows } = await pool.query(query, params);
  if (!rows.length) return res.status(404).json({ error: 'Pari introuvable' });
  res.json(await getPariWithJoueurs(rows[0].id));
}));

app.delete('/api/paris/:id', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('DELETE FROM paris WHERE id=$1 RETURNING id', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Pari introuvable' });
  res.json({ ok: true });
}));

// ----- Joueurs d'un pari -----
app.post('/api/paris/:id/joueurs', asyncHandler(async (req, res) => {
  const { nom, mise = '', gage = '' } = req.body;
  if (!nom || !nom.trim()) return res.status(400).json({ error: 'Un nom de joueur est requis' });
  // Vérifie que le pari existe
  const pari = await getPariWithJoueurs(req.params.id);
  if (!pari) return res.status(404).json({ error: 'Pari introuvable' });
  // Pas de doublon de nom dans le même pari
  const existing = pari.joueurs || [];
  if (existing.some(j => j.nom.toLowerCase() === nom.trim().toLowerCase())) {
    return res.status(400).json({ error: 'Ce joueur est déjà dans le pari' });
  }
  const { rows } = await pool.query(
    'INSERT INTO paris_joueurs (pari_id, nom, mise, gage) VALUES ($1,$2,$3,$4) RETURNING *',
    [req.params.id, nom.trim(), mise, gage]
  );
  res.json(rows[0]);
}));

app.put('/api/paris/joueurs/:id', asyncHandler(async (req, res) => {
  const { nom, mise, gage } = req.body;
  let query = 'UPDATE paris_joueurs SET ';
  const sets = [];
  const params = [];
  if (nom !== undefined) { params.push(nom); sets.push(`nom = $${params.length}`); }
  if (mise !== undefined) { params.push(mise); sets.push(`mise = $${params.length}`); }
  if (gage !== undefined) { params.push(gage); sets.push(`gage = $${params.length}`); }
  if (!sets.length) return res.status(400).json({ error: 'Aucun champ à mettre à jour' });
  params.push(req.params.id);
  query += sets.join(', ') + ` WHERE id = $${params.length} RETURNING *`;
  const { rows } = await pool.query(query, params);
  if (!rows.length) return res.status(404).json({ error: 'Joueur introuvable' });
  res.json(rows[0]);
}));

app.delete('/api/paris/joueurs/:id', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('DELETE FROM paris_joueurs WHERE id=$1 RETURNING id', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Joueur introuvable' });
  res.json({ ok: true });
}));

// ---------- Compteur Harebourg ----------
// Compte les donjons effectués et les bandelettes de Harebourg lootées.
// Sur le serveur d'exposition, "un donjon" = une victoire sur le Comte
// → pas de multiplication à faire côté client (le +1 se fait ici).
app.get('/api/harebourg', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT donjons, bandelettes, "updatedAt" FROM harebourg_stats WHERE id = 1'
  );
  if (!rows.length) return res.json({ donjons: 0, bandelettes: 0, updatedAt: null });
  res.json(rows[0]);
}));

// +1 donjon
app.post('/api/harebourg/donjon', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `INSERT INTO harebourg_stats (id, donjons, bandelettes)
     VALUES (1, 1, 0)
     ON CONFLICT (id) DO UPDATE SET
       donjons = harebourg_stats.donjons + 1,
       "updatedAt" = now()
     RETURNING donjons, bandelettes, "updatedAt"`,
  );
  res.json(rows[0]);
}));

// +1 bandelette
app.post('/api/harebourg/bandelette', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `INSERT INTO harebourg_stats (id, donjons, bandelettes)
     VALUES (1, 0, 1)
     ON CONFLICT (id) DO UPDATE SET
       bandelettes = harebourg_stats.bandelettes + 1,
       "updatedAt" = now()
     RETURNING donjons, bandelettes, "updatedAt"`,
  );
  res.json(rows[0]);
}));

// Mise à jour / remise à zéro des compteurs
app.put('/api/harebourg', asyncHandler(async (req, res) => {
  const { donjons, bandelettes } = req.body;
  if (donjons === undefined && bandelettes === undefined) {
    return res.status(400).json({ error: 'Préciser donjons et/ou bandelettes' });
  }
  const { rows } = await pool.query(
    `INSERT INTO harebourg_stats (id, donjons, bandelettes)
     VALUES (1, $1, $2)
     ON CONFLICT (id) DO UPDATE SET
       donjons = $1,
       bandelettes = $2,
       "updatedAt" = now()
     RETURNING donjons, bandelettes, "updatedAt"`,
    [
      donjons !== undefined ? Math.max(0, parseInt(donjons) || 0) : 0,
      bandelettes !== undefined ? Math.max(0, parseInt(bandelettes) || 0) : 0
    ]
  );
  res.json(rows[0]);
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

  const { crafts, recipes, brutes, errors, ingredientNames } = await computeFarmList(farmItems);

  const resourceTotals = {};

  function addResource(id, name, qte) {
    if (!resourceTotals[id]) resourceTotals[id] = { name, qte: 0 };
    resourceTotals[id].qte += qte;
  }

  function nameOf(recipe) {
    if (!recipe) return 'Inconnu';
    const rn = recipe.resultName;
    if (rn && rn.fr) return rn.fr;
    if (typeof rn === 'string') return rn;
    return 'Inconnu';
  }

  // Calcul du nombre TOTAL d'unités nécessaires de chaque craftable :
  // demande directe (quantité saisie) + besoins indirects
  // (l'item est ingrédient d'un autre craftable demandé).
  // Exemple : item A nécessite 3×B et l'utilisateur demande 4×B →
  // needed[B] = 4 + 3 × needed[A].
  const neededCache = new Map();
  function computeNeededUnits(id) {
    if (neededCache.has(id)) return neededCache.get(id);
    const craft = crafts[id];
    if (!craft) { neededCache.set(id, 0); return 0; }
    let total = craft.total;
    neededCache.set(id, total); // anti-cycle (recettes Dofus = DAG)
    for (const [parentId, parentCraft] of Object.entries(crafts)) {
      if (parentId == id) continue;
      const qpu = parentCraft.qtyPerUnit[id];
      if (!qpu) continue;
      total += qpu * computeNeededUnits(parentId);
    }
    neededCache.set(id, total);
    return total;
  }

  // Décompose la recette d'un craftable pour `units` unités. Les ingrédients
  // qui sont eux-mêmes craftables sont ignorés ici : ils ont leur propre
  // entrée dans `crafts` et seront décomposés par leur propre itération
  // avec la bonne quantité (besoin total direct + indirect).
  function decompose(craftId, units) {
    if (units <= 0) return;
    const craft = crafts[craftId];
    if (!craft) return;
    for (const [ingIdStr, qpu] of Object.entries(craft.qtyPerUnit)) {
      const ingId = parseInt(ingIdStr);
      if (crafts[ingId]) continue; // craftable imbriqué → son propre passage
      const totalQte = qpu * units;
      addResource(ingId, ingredientNames.get(ingId) || nameOf(recipes.get(ingId)), totalQte);
    }
  }

  // Décompose chaque craftable de l'arbre selon ses besoins totaux.
  for (const cidStr of Object.keys(crafts)) {
    const cid = parseInt(cidStr);
    decompose(cid, computeNeededUnits(cid));
  }

  // Ressources brutes directement demandées (items sans recette)
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
      return { id: parseInt(id), name: info.name, total, stock, toFarm: Math.max(0, total - stock) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  res.json({ resources: finalList, errors });
}));

// ---------- Démarrage ----------
initDb().then(async () => {
  app.listen(PORT, () => {
    console.log(`🚀 DofLib démarré sur le port ${PORT}`);
  });

  // Scraping automatique au premier démarrage (si la base est incomplète)
  // Le scraping a une reprise automatique : les items déjà en base sont
  // sautés, donc pas de double téléchargement.
  try {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM dofus_items');
    if (rows[0].count < 10000) {
      console.log(`🔄 Base d'items incomplète (${rows[0].count}/~20000) → scraping de reprise lancé…`);
      await startScrape(null);
    } else {
      console.log(`✅ ${rows[0].count} items en base, scraping non nécessaire`);
    }
  } catch (e) {
    console.error('⚠️ Vérification items/scraping:', e.message);
  }

  // Scraping automatique des recettes (si la table dofus_recipes est vide)
  // Réplique le script Google Sheets ACTUALISER_DB_ITEMS (endpoint /recipes)
  try {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM dofus_recipes');
    if (rows[0].count === 0) {
      console.log('🔄 Table recettes vide → lancement du scraping des recettes DofusDB…');
      await startRecipesScrape();
    } else {
      console.log(`✅ ${rows[0].count} recettes déjà en base, scraping non nécessaire`);
    }
  } catch (e) {
    console.error('⚠️ Vérification recettes/scraping:', e.message);
  }
}).catch(e => {
  console.error('❌ Erreur de démarrage:', e.message);
  process.exit(1);
});
