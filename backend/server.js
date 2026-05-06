import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const VOYAGE_KEY = process.env.VOYAGE_API_KEY;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5';
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

// ── Retry avec backoff exponentiel ────────────────────────────────────────────
async function withRetry(fn, label = '?', maxAttempts = 3) {
  let lastErr;
  for (let i = 0; i < maxAttempts; i++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      const isLast = i === maxAttempts - 1;
      const isRetriable = err.status === 429 || err.status === 503 || (err.status >= 500 && err.status < 600) || /timeout|ECONNRESET|fetch failed/i.test(String(err.message));
      console.error(`[${label}] attempt ${i + 1}/${maxAttempts} failed: ${err.message || err.status}`);
      if (isLast || !isRetriable) break;
      const delay = Math.min(1000 * Math.pow(2, i), 8000) + Math.random() * 500;
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// ── Embedding via Voyage AI ───────────────────────────────────────────────────
async function voyageEmbed(text, inputType = 'query') {
  return withRetry(async () => {
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${VOYAGE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'voyage-3', input: [text], input_type: inputType }),
    });
    if (!res.ok) {
      const e = new Error(`Voyage ${res.status}: ${await res.text()}`);
      e.status = res.status;
      throw e;
    }
    const json = await res.json();
    return json.data[0].embedding;
  }, 'voyage');
}

// ── Stop-words FR pour fallback keyword extraction ────────────────────────────
const STOP_WORDS_FR = new Set([
  'le','la','les','un','une','des','de','du','en','et','ou','est','sont','etre','ete',
  'quel','quelle','quels','quelles','que','qui','quoi','comment','pourquoi','quand',
  'a','au','aux','ce','cette','ces','ma','mon','mes','ta','ton','tes','sa','son','ses',
  'notre','votre','leur','leurs','me','te','se','nous','vous','il','elle','ils','elles',
  'je','tu','chez','sur','sous','dans','avec','pour','par','sans','cas','si','taux',
  'plus','tout','tous','toute','toutes','mais','donc','car','ne','pas','non','oui',
  'fait','faire','peut','peuvent','dois','doit','doivent','avoir','ai','as','aurait',
  'puis','peux','sera','etait','etaient','grdf','dit','dire'
]);
function extractKeywords(text) {
  return text
    .toLowerCase()
    .replace(/[''’]/g, ' ')
    .split(/[^a-zàâäéèêëîïôöùûüÿç0-9-]+/i)
    .filter(w => w.length > 1 && !STOP_WORDS_FR.has(w))
    .slice(0, 12)
    .join(' ');
}

// ── Query expansion via Claude Haiku ──────────────────────────────────────────
async function expandQuery(question) {
  try {
    const r = await withRetry(
      () => anthropic.messages.create({
        model: HAIKU_MODEL,
        max_tokens: 100,
        system: [
          "Tu es un expert syndical IEG/GRDF qui aide à générer des mots-clés de recherche. Tu reçois une question utilisateur — qui peut contenir des FAUTES D'ORTHOGRAPHE, des apostrophes manquantes, des accents oubliés, des sigles mal écrits.",
          "Étapes :",
          " 1. Corrige mentalement TOUTES les fautes : orthographe, accords, accents, conjugaisons, frappes inversées, apostrophes manquantes (dinvalidite → invalidite, abondemen → abondement, retrate → retraite, syndicale → syndicale, intéressment → interessement, primre → prime).",
          " 2. Identifie le concept syndical IEG dont parle la question — même si l'utilisateur utilise un terme du régime général (catégorie 2 → incapacité totale ; arrêt maladie → maladie longue ; mutuelle → CAMIEG ; retraite complémentaire → PERCOL).",
          " 3. Génère 3 à 6 mots-clés français qui figurent EXACTEMENT dans le vocabulaire des accords IEG, en minuscule sans accents.",
          "Règles :",
          " - Privilégie les sigles spécifiques IEG : CNIEG, CAMIEG, CSP, CSNP, IRP, CSE, CSSCT, PEG, PERCOL, PEI, NR, NRn, GMR, IEG, AT, MP, IVD",
          " - Inclus les identifiants exacts s'ils sont mentionnés (PERS 187, DP37-44, ENN1129…)",
          " - Évite les mots génériques seuls (PERS sans numéro, rente, categorie, taux, montant) sauf s'ils sont centraux",
          "Réponds UNIQUEMENT avec les 3 à 6 mots-clés séparés par des espaces, en minuscule, sans accents, sans phrase, sans ponctuation, sans explication.",
          "Exemples (la question peut contenir des fautes — corrige-les) :",
          "  « Quel taux dabondement ? » → « abondement interessement plafond peg percol »",
          "  « cas dinvalidite tipe 2 ? » → « invalidite incapacite pension cniega complement »",
          "  « Quels droit en cas darret maladi ? » → « maladie arret pension cniega caamieg »",
          "  « Comben je gagn en astrente ? » → « astreinte sujetions service indemnite PERS194 »",
          "  « vol matériel info procedure disciplinare » → « discipline sanction csp pers846 vol »",
        ].join('\n'),
        messages: [{ role: 'user', content: question }],
      }),
      'haiku-expand',
      2
    );
    const expanded = r.content[0].text.trim().replace(/[\n\r]/g, ' ').slice(0, 200);
    console.log('Query expansion:', expanded);
    return expanded;
  } catch (e) {
    console.error('Haiku expand failed:', e.message);
    return null;
  }
}

// ── Recherche hybride v3 ──────────────────────────────────────────────────────
async function searchDocuments(query, limit = 15) {
  try {
    const embedding = await voyageEmbed(query, 'query');
    const expanded = await expandQuery(query);
    const fallbackKw = extractKeywords(query) || query;
    const keywords = expanded || fallbackKw;
    console.log('FT keywords:', keywords);
    const { data, error } = await supabase.rpc('hybrid_search_v3', {
      query_text: keywords,
      query_embedding: embedding,
      match_count: limit,
      full_text_weight: 2.0,
      semantic_weight: 1.0,
      filename_weight: 5.0,
      rrf_k: 50,
    });
    if (error) throw error;
    return data || [];
  } catch (err) {
    console.error('Erreur recherche documents:', err.message);
    return [];
  }
}

// ── Route principale ──────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message) return res.status(400).json({ error: 'Message manquant' });

  try {
    const docs = await searchDocuments(message);

    let context = '';
    if (docs.length > 0) {
      context += 'DOCUMENTS INTERNES FO ÉNERGIE GRDF / IEG\n\n';
      docs.forEach((doc, i) => {
        const sim = doc.similarity ? ` (similarité ${(doc.similarity * 100).toFixed(0)}%)` : '';
        context += `--- Source ${i + 1}: ${doc.source}${sim} ---\n${doc.content}\n\n`;
      });
    }

    const systemPrompt = `Tu es **FO-UND**, l'assistant syndical officiel de **FO Énergie GRDF**.
Tu réponds aux militants et aux salariés relevant du **statut national des IEG** (Industries Électriques et Gazières), employés de **GRDF** ou d'entités proches (Enedis, EDF, GRTgaz, RTE).

═══════════════════════════════════════════════════════════════
TA MISSION
═══════════════════════════════════════════════════════════════
Aider l'utilisateur à comprendre ses droits, les accords collectifs applicables, les pratiques de l'entreprise GRDF et la législation du travail française.

═══════════════════════════════════════════════════════════════
RÈGLES ABSOLUES — NON-NÉGOCIABLES
═══════════════════════════════════════════════════════════════
1. **Langue** : toujours répondre en français professionnel mais accessible.

2. **Sources** : tu t'appuies UNIQUEMENT sur le contexte documentaire fourni ci-dessous.
   - Si une info ne figure pas dans le contexte, dis-le explicitement.
   - Si le contexte est vide ou hors sujet, ne fais que des rappels généraux et oriente vers la section syndicale.

3. **🚫 INTERDICTION ABSOLUE D'INVENTER UNE RÉFÉRENCE.**
   - Tu ne dois JAMAIS citer un numéro de PERS, DP, ENN, N, article de loi, jurisprudence, accord, ou date qui n'apparaît pas EXPLICITEMENT dans le contexte fourni.
   - Si l'utilisateur te demande "Que dit la PERS X ?" et que cette PERS X n'est pas dans le contexte : dis « La PERS X n'est pas dans ma base documentaire actuelle ». Ne mentionne PAS d'autres PERS sauf s'ils figurent vraiment dans le contexte.
   - Pareil pour les articles : ne cite jamais "article L.X-Y du Code du travail" sans être absolument sûr qu'il figure dans le contexte.
   - Si tu ne sais pas, dis « Je ne sais pas » plutôt que d'inventer.

4. **Citations** : à la fin de CHAQUE affirmation factuelle, cite la source au format \`[Réf: NOM_DU_FICHIER]\`.
   Exemple : "Le maintien de salaire est de 12 mois [Réf: PERS191.pdf]."
   N'utilise QUE les noms de fichier qui figurent dans la liste des sources fournies.

5. **Hiérarchie des normes** (du plus protecteur au moins protecteur) :
   1. Statut national du personnel des IEG (textes PERS, ENN, DP, N…)
   2. Accords de branche IEG
   3. Accords d'entreprise GRDF
   4. Code du travail
   En cas de divergence, **applique la disposition la plus favorable au salarié**.

6. **Si l'info manque** : dis-le honnêtement et oriente vers la section syndicale :
   - Mail : syndicat-fo_grdf-delegations-nationales@grdf.fr
   - Instagram : @FO_GRDF
   Ne renvoie JAMAIS l'utilisateur vers ChatGPT, Wikipedia ou un autre site externe.

═══════════════════════════════════════════════════════════════
SIGLES & VOCABULAIRE
═══════════════════════════════════════════════════════════════
- **IEG** : Industries Électriques et Gazières (branche)
- **PERS** : circulaire du statut du personnel IEG
- **ENN** : décision d'extension appliquant un PERS
- **DP** : directive personnel
- **CSP** : commission secondaire du personnel
- **IRP** : instances représentatives du personnel
- **CSE / CSSCT** : Comité Social et Économique / Commission Santé Sécurité Conditions de Travail
- **NR / NRn** : Niveau de Rémunération (grille IEG)
- **CCAS / CMCAS** : activités sociales IEG
- **CNIEG** : Caisse Nationale des IEG (gère retraite et invalidité)
- **CAMIEG** : Caisse d'Assurance Maladie des IEG
- **GMR** : Groupement de maintenance régional GRDF
- **AT / MP** : accident du travail / maladie professionnelle
- **PEG / PERCOL** : Plan d'Épargne Groupe / Plan d'Épargne Retraite COLlectif

═══════════════════════════════════════════════════════════════
STRUCTURE DE RÉPONSE
═══════════════════════════════════════════════════════════════
1. **Réponse directe** en 1-2 phrases (le verdict).
2. **Détail** : disposition exacte, durée, conditions, montants — chaque ligne sourcée.
3. **Démarches concrètes** : qui contacter, quel formulaire, quel délai.
4. **Vigilance** : ce qui peut bloquer, les pièges si dans le contexte.
5. **Pour aller plus loin** : références FO ou contact section syndicale.

Évite les listes à puces interminables : préfère du texte clair avec quelques points ciblés.

═══════════════════════════════════════════════════════════════
TON
═══════════════════════════════════════════════════════════════
Professionnel, militant, factuel. Tu es à l'écoute mais tu ne fais pas de psychologie. Tu ne juges pas l'employeur, mais tu rappelles les droits avec fermeté.

${context ? `═══════════════════════════════════════════════════════════════
CONTEXTE DOCUMENTAIRE POUR CETTE QUESTION
═══════════════════════════════════════════════════════════════
${context}` : 'Aucun document interne pertinent n\'a été trouvé pour cette question. Tu peux faire un rappel général sur les principes du statut IEG et du Code du travail SANS citer de numéro précis (PERS, DP, ENN, articles), et oriente vers la section syndicale FO.'}`;

    const messages = [
      ...history.map(h => ({ role: h.role, content: h.content })),
      { role: 'user', content: message },
    ];

    const response = await withRetry(
      () => anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 2000,
        system: systemPrompt,
        messages,
      }),
      'anthropic'
    );
    const answer = response.content[0].text;

    const sources = docs.map(d => ({
      type: 'internal',
      ref: d.source,
      label: d.source,
      similarity: d.similarity,
    }));

    res.json({ answer, sources });
  } catch (err) {
    console.error('Erreur chat:', err);
    res.status(500).json({ error: 'Erreur serveur', detail: err.message });
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'FO-UND API' }));
app.get('/version', (_, res) => res.json({ build: 'v10-typo-tolerant', rpc: 'hybrid_search_v3', deployed: new Date().toISOString() }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ FO-UND backend démarré sur le port ${PORT}`));
