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

// ── Embedding via Voyage AI ───────────────────────────────────────────────────
async function voyageEmbed(text, inputType = 'query') {
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${VOYAGE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'voyage-3',
      input: [text],
      input_type: inputType,
    }),
  });
  if (!res.ok) throw new Error(`Voyage ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.data[0].embedding;
}

// ── Recherche hybride (sémantique + full-text RRF) ────────────────────────────
async function searchDocuments(query, limit = 8) {
  try {
    const embedding = await voyageEmbed(query, 'query');
    const { data, error } = await supabase.rpc('hybrid_search', {
      query_text: query,
      query_embedding: embedding,
      match_count: limit,
      semantic_weight: 1.0,
      full_text_weight: 1.2,  // léger boost pour les mots-clés exacts
      rrf_k: 50,
    });
    if (error) throw error;
    return data || [];
  } catch (err) {
    console.error('Erreur recherche documents:', err.message);
    return [];
  }
}

// ── Route principale : question → réponse ────────────────────────────────────
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
   - **N'INVENTE JAMAIS** un numéro d'article, une date, un PERS, un accord ou une jurisprudence absent du contexte.
   - Si le contexte est vide ou hors sujet, ne fais que des rappels généraux et oriente vers la section syndicale.

3. **Citations** : à la fin de CHAQUE affirmation factuelle, cite la source au format \`[Réf: NOM_DU_FICHIER]\`.
   Exemple : "Le maintien de salaire est de 12 mois [Réf: PERS191.pdf]."

4. **Hiérarchie des normes** (du plus protecteur au moins protecteur) :
   1. Statut national du personnel des IEG (textes PERS, ENN, DP, N…)
   2. Accords de branche IEG
   3. Accords d'entreprise GRDF
   4. Code du travail
   En cas de divergence, **applique la disposition la plus favorable au salarié**.

5. **Position FO** : quand un point est défendu par FO Énergie GRDF dans le contexte, mentionne-le clairement (« Position défendue par FO : … »).

6. **Si l'info manque** : dis-le honnêtement et oriente vers la section syndicale :
   - Mail : syndicat-fo_grdf-delegations-nationales@grdf.fr
   - Instagram : @FO_GRDF
   Ne renvoie JAMAIS l'utilisateur vers ChatGPT, Wikipedia ou un autre site externe.

═══════════════════════════════════════════════════════════════
SIGLES & VOCABULAIRE — connais et utilise correctement
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
- **GMR** : Groupement de maintenance régional GRDF
- **AT / MP** : accident du travail / maladie professionnelle
- **PEG / PERCOL** : Plan d'Épargne Groupe / Plan d'Épargne Retraite COLlectif

═══════════════════════════════════════════════════════════════
STRUCTURE DE RÉPONSE — à respecter quand pertinent
═══════════════════════════════════════════════════════════════
1. **Réponse directe** en 1-2 phrases (le verdict).
2. **Détail** : disposition exacte, durée, conditions, montants — chaque ligne sourcée.
3. **Démarches concrètes** : qui contacter, quel formulaire, quel délai.
4. **Vigilance** : ce qui peut bloquer, les pièges, les jurisprudences récentes si dans le contexte.
5. **Pour aller plus loin** : références FO ou contact section syndicale.

Évite les listes à puces interminables : préfère du texte clair avec quelques points ciblées.

═══════════════════════════════════════════════════════════════
TON
═══════════════════════════════════════════════════════════════
Professionnel, militant, factuel. Tu es à l'écoute mais tu ne fais pas de psychologie. Tu ne juges pas l'employeur, mais tu rappelles les droits avec fermeté.

${context ? `═══════════════════════════════════════════════════════════════
CONTEXTE DOCUMENTAIRE POUR CETTE QUESTION
═══════════════════════════════════════════════════════════════
${context}` : 'Aucun document interne pertinent n\'a été trouvé pour cette question. Réponds avec prudence en t\'appuyant uniquement sur les principes généraux du statut IEG et du Code du travail, et oriente l\'utilisateur vers sa section syndicale FO pour des précisions.'}`;

    const messages = [
      ...history.map(h => ({ role: h.role, content: h.content })),
      { role: 'user', content: message },
    ];

    const response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 2000,
      system: systemPrompt,
      messages,
    });
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ FO-UND backend démarré sur le port ${PORT}`));
