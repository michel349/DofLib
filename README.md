# 🎮 DofLib

**Gestionnaire de farm list, objectifs, prix HDV, brouillons et stuffs pour Dofus**

Remplace ton Google Sheet avec une app web reliée à l'API [DofusDB](https://dofusdb.fr).

## ✨ Fonctionnalités

- 🧺 **Farm List** : entre les items à craft, l'app génère automatiquement la liste des ressources à farmer (calcul récursif des sous-recettes)
- 🎯 **Objectifs** : liste de tâches avec quantité, deadline et statut
- 🪙 **Prix HDV** : suivi des prix de l'hôtel de vente
- 📝 **Brouillons** : notes rapides
- 🎒 **Stuffs** : enregistre tes stuffs et leurs items
- 📦 **Inventaire** : indique ton stock pour que le calculateur soustraie ce que tu as déjà

## 🚀 Déploiement sur Railway (depuis GitHub)

### 1. Pousser le projet sur GitHub

```bash
git init
git add -A
git commit -m "Initial commit DofLib"
git branch -M main
git remote add origin https://github.com/TON_USER/doflib.git
git push -u origin main
```

### 2. Créer le projet sur Railway

1. Va sur [railway.app](https://railway.app) et connecte-toi avec ton compte GitHub
2. Clique sur **New Project** → **Deploy from GitHub repo**
3. Sélectionne ton repo **doflib**
4. Railway détecte automatiquement le `Procfile` et lance `node server.js`

### 3. Ajouter PostgreSQL (obligatoire)

DofLib exige **PostgreSQL**. Sans `DATABASE_URL`, le serveur refuse de démarrer.

1. Dans ton projet Railway, clique sur **New** → **Database** → **Add PostgreSQL**
2. Ouvre ensuite **ton service web** → onglet **Variables**
3. Vérifie que `DATABASE_URL` y est bien présente (valeur du type `postgresql://...`)
   - Si elle n'y est pas : va sur la base PostgreSQL → onglet **Variables** → copie `DATABASE_URL` → ajoute-la dans le service web
4. Clique sur **Deploy** pour redémarrer
5. Le schéma des tables est créé automatiquement au premier démarrage ✅

### 4. Profiter 🎉

Ton app est disponible sur une URL du type `https://doflib-production.up.railway.app`

## 🐳 Développement local (optionnel)

PostgreSQL est obligatoire, même en local.

```bash
# 1. Crée un fichier .env avec ta DATABASE_URL (ou utilise celle de Railway)
echo "DATABASE_URL=postgresql://..." > .env

# 2. Récupère la dernière version de dotenv
npm install dotenv

# 3. Ajoute en toute première ligne de server.js :
#    require('dotenv').config();

# 4. Lance
npm install
npm start
```

Ouvre [http://localhost:3000](http://localhost:3000)

## 🛠️ API DofusDB utilisée

- Recherche d'items : `GET https://api.dofusdb.fr/items?search[name]=...&lang=fr`
- Recettes de craft : `GET https://api.dofusdb.fr/recipes?resultId=<itemId>`

## 📁 Structure du projet

```
DofLib/
├── server.js          # API Express + calculateur récursif de craft
├── package.json       # Dépendances & scripts
├── Procfile           # Point d'entrée Railway
├── public/
│   └── index.html     # Interface (HTML/CSS/JS pur, pas de build)
└── .gitignore
```

## 🧩 Personnaliser

- **Couleurs** : modifie les variables CSS `:root` dans `public/index.html`
- **Emojis des onglets** : modifie les emojis dans les `data-tab` de la barre de navigation
- **Limite de recherche** : change `limit=8` dans `searchDofusDB()` de `server.js`