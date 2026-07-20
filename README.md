# FO-UND — Assistant Syndical FO Énergie GRDF

> L'assistant IA qui trouve tout. Pour les militants FO Énergie GRDF.

---

## 🗂️ Structure du projet

```
fo-und/
├── frontend/
│   └── index.html          ← Interface web (GitHub Pages)
├── backend/
│   ├── server.js           ← Serveur API (Render.com)
│   ├── package.json
│   └── .env.example        ← Modèle de configuration
└── scripts/
    ├── supabase_setup.sql  ← Script base de données
    ├── index_documents.mjs ← Indexation des 500 fichiers
    └── package.json
```

---

## 🚀 Déploiement — étape par étape

### ÉTAPE 1 — Supabase (base de données)

1. Connecte-toi sur [supabase.com](https://supabase.com)
2. Crée un projet `fo-und` (région : West Europe)
3. Va dans **SQL Editor** → colle et exécute le contenu de `scripts/supabase_setup.sql`
4. Va dans **Project Settings → API** et note :
   - `Project URL` → c'est ton `SUPABASE_URL`
   - `service_role` key → c'est ton `SUPABASE_SERVICE_KEY`

### ÉTAPE 2 — Indexer tes documents

Sur ton Mac, dans le terminal :

```bash
# Aller dans le dossier scripts
cd fo-und/scripts

# Installer les dépendances
npm install

# Créer le fichier de config
cp /path/to/.env.example .env
# Éditer .env avec tes vraies clés

# Lancer l'indexation (dossier Cowork)
node index_documents.mjs --dir /Users/lopesmickael/Cowork
```

⏱️ Prévoir 30-60 min selon le volume de fichiers.

### ÉTAPE 3 — Déployer le backend sur Render

1. Va sur [render.com](https://render.com) → **New Web Service**
2. Connecte ton dépôt GitHub
3. Paramètres :
   - **Root Directory** : `backend`
   - **Build Command** : `npm install`
   - **Start Command** : `node server.js`
4. Dans **Environment Variables**, ajoute :
   ```
   ANTHROPIC_API_KEY=sk-ant-api03-...
   SUPABASE_URL=https://xxx.supabase.co
   SUPABASE_SERVICE_KEY=eyJ...
   ```
5. Clique **Deploy** — Render donne une URL type `https://fo-und-backend.onrender.com`

### ÉTAPE 4 — Mettre à jour le frontend

Dans `frontend/index.html`, ligne ~210, remplace :
```javascript
const API_URL = 'https://fo-und-backend.onrender.com';
```
Par l'URL réelle donnée par Render.

### ÉTAPE 5 — Déployer le frontend sur GitHub Pages

```bash
# Dans ton dépôt GitHub
# Va dans Settings → Pages
# Source : Deploy from branch → main → /frontend
# Ton URL sera : https://TON_USERNAME.github.io/fo-und/
```

Ajoute le logo dans `frontend/` :
```bash
cp Logo_FO_Energie_GRDF.jpg frontend/
```

---

## 📋 Variables d'environnement

| Variable | Où la trouver |
|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys |
| `SUPABASE_URL` | supabase.com → Project Settings → API |
| `SUPABASE_SERVICE_KEY` | supabase.com → Project Settings → API (service_role) |

---

## 💰 Coût estimé

| Service | Plan | Coût |
|---|---|---|
| GitHub Pages | Free | 0€ |
| Render.com | Free | 0€ |
| Supabase | Free | 0€ |
| Anthropic API | Pay-as-you-go | ~2-10€/mois |

---

## 🔧 Formats de fichiers supportés

L'indexation supporte actuellement `.txt` et `.md`.
Pour PDF et DOCX, convertis-les d'abord en texte ou contacte-nous pour une version étendue.

---

## 📞 Support

Développé par DESTINATION PRÉVENTION — destination-prevention.fr

---

## 🔄 Mise à jour du 20/07/2026 — remise en état complète

**Ce qui a changé** (suite à l'audit : base Supabase supprimée + 292 PDF scannés jamais lus) :

| Fichier | Rôle |
|---|---|
| `scripts/supabase_setup_v2.sql` | Recrée TOUT : table + index + fonction `hybrid_search_v3` (le SQL v1 ne la créait pas) |
| `scripts/index_documents_v4.mjs` | Indexation avec prise en charge du dossier `OCR_FO-UND` + rapport qualité `rapport_indexation.csv` |
| `scripts/test_recette.mjs` | Batterie de 15 questions-tests contre le backend en prod |
| `.github/workflows/keepalive.yml` | Ping 2×/semaine → Supabase ne sera plus jamais mis en pause/supprimé |
| `backend/server.js` v13 | Endpoint `/stats` (état de la base) + panne de recherche VISIBLE (plus d'échec silencieux) |

**OCR** : les PDF scannés (accords GRDF signés, PERS anciens) sont océrisés via Apple Vision
(script local, sortie `.txt` dans `Dossier ressources /OCR_FO-UND/`, miroir de l'arborescence).
L'indexeur v4 remplace automatiquement chaque PDF scanné par son `.txt` océrisé,
en gardant le nom du PDF original comme source de citation.

**Réindexation complète** :
```bash
cd scripts
node index_documents_v4.mjs --dir "/Users/lopesmickael/Documents/FNEM/FO service gaz/Dossier ressources "
node test_recette.mjs   # recette
```
