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

// ── Recherche vectorielle dans les documents ──────────────────────────────────
async function searchDocuments(query, limit = 5) {
  try {
    const embedding = await voyageEmbed(query, 'query');
    const { data, error } = await supabase.rpc('match_documents', {
      query_embedding: embedding,
      match_threshold: 0.3,
      match_count: limit,
    });
    if (error) throw error;
    return data || [];
  } catch (err) {
    console.error('Erreur recherche documents:', err.message);
    return [];
  }
}

// ── Recherche OpenLegi / Légifrance ───────────────────────────────────────────
async function searchLegifrance(query) {
  try {
    const res = await fetch('https://mcp.openlegi.fr/legifrance/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, limit: 3 }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.results || [];
  } catch (err) {
    console.error('Erreur OpenLegi:', err.message);
    return [];
  }
}

function needsLegalSearch(query) {
  const keywords = [
    'article', 'loi', 'code du travail', 'jurisprudence', 'arrêt', 'décret',
    'légifrance', 'légal', 'juridique', 'texte de loi', 'l.', 'r.', 'l3', 'l2',
  ];
  return keywords.some(k => query.toLowerCase().includes(k));
}

// ── Route principale : question → réponse ────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message) return res.status(400).json({ error: 'Message manquant' });

  try {
    const docs = await searchDocuments(message);
    const legalResults = needsLegalSearch(message) ? await searchLegifrance(message) : [];

    let context = '';
    if (docs.length > 0) {
      context += '## Documents internes FO Énergie GRDF\n\n';
      docs.forEach(doc => {
        context += `### [${doc.source}]\n${doc.content}\n\n`;
      });
    }
    if (legalResults.length > 0) {
      context += '## Textes juridiques (Légifrance)\n\n';
      legalResults.forEach(r => {
        context += `### ${r.title || r.reference}\n${r.content || r.summary}\n\n`;
      });
    }

    const systemPrompt = `Tu es FO-UND, l'assistant syndical officiel de FO Énergie GRDF.
Tu aides les militants syndicaux à comprendre leurs droits, les accords collectifs et la législation du travail.

RÈGLES STRICTES :
- Réponds toujours en français, avec un ton professionnel mais accessible
- Base tes réponses UNIQUEMENT sur les documents fournis et les textes juridiques
- Cite toujours tes sources avec le format [Réf: NOM_SOURCE]
- Si tu n'as pas l'information, dis-le clairement plutôt que d'inventer
- Mets en avant les droits des salariés et les dispositions les plus favorables
- Pour les questions complexes, structure ta réponse avec des points clés

${context ? `CONTEXTE DISPONIBLE :\n${context}` : 'Aucun document pertinent trouvé pour cette question.'}`;

    const messages = [
      ...history.map(h => ({ role: h.role, content: h.content })),
      { role: 'user', content: message },
    ];

    const response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 1500,
      system: systemPrompt,
      messages,
    });
    const answer = response.content[0].text;

    const sources = [
      ...docs.map(d => ({ type: 'internal', ref: d.source, label: d.source, similarity: d.similarity })),
      ...legalResults.map(r => ({ type: 'legal', ref: r.reference, label: r.title || r.reference })),
    ];

    res.json({ answer, sources });
  } catch (err) {
    console.error('Erreur chat:', err);
    res.status(500).json({ error: 'Erreur serveur', detail: err.message });
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'FO-UND API' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ FO-UND backend démarré sur le port ${PORT}`));
