#!/usr/bin/env node
/**
 * FO-UND — Indexation v4 (20/07/2026)
 * Nouveautés :
 *  - Prise en charge du dossier OCR_FO-UND : un PDF scanné est remplacé
 *    par son .txt océrisé (le PDF est alors ignoré, pas de doublon)
 *  - La source citée reste le nom du PDF original (citations propres)
 *  - Rapport qualité par fichier : rapport_indexation.csv
 *  - Aucun échec silencieux : tout fichier ignoré est listé avec sa raison
 * Usage : node index_documents_v4.mjs --dir "/chemin/Dossier ressources "
 */
import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import pdf from 'pdf-parse/lib/pdf-parse.js';
import mammoth from 'mammoth';

dotenv.config();
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const VOYAGE_KEY = process.env.VOYAGE_API_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY || !VOYAGE_KEY) {
  console.error('❌ .env incomplet (SUPABASE_URL / SUPABASE_SERVICE_KEY / VOYAGE_API_KEY)');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 150;
const BATCH_SIZE = 8;
const OCR_DIR = 'OCR_FO-UND';
const SUPPORTED_EXT = ['.txt', '.md', '.pdf', '.docx', '.html', '.htm'];
const MAX_FILE_BYTES = 30 * 1024 * 1024;

function cleanText(text) {
  if (!text) return '';
  return text
    .replace(/DocuSign Envelope ID:\s*[A-F0-9-]+/gi, ' ')
    .replace(/[◼➢▪✓●○■□◆◇▶►•·]\s*[◼➢▪✓●○■□◆◇▶►•·\s]{2,}/g, ' ')
    .replace(/(?:[\s]*[-_=*~–—\.]){4,}/g, ' ')
    .replace(/Page\s+\d+\s+(?:sur|of|\/)\s+\d+/gi, ' ')
    .replace(/\[email[\s]*protected\]/gi, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function chunkText(text, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  if (!text) return [];
  const chunks = [];
  const paragraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  let current = '';
  for (const para of paragraphs) {
    if (current.length === 0) current = para;
    else if (current.length + para.length + 2 <= size) current += '\n\n' + para;
    else {
      if (current.length > 100) chunks.push(current);
      const tail = current.slice(-overlap);
      current = tail + '\n\n' + para;
      while (current.length > size * 1.5) {
        chunks.push(current.slice(0, size));
        current = current.slice(size - overlap);
      }
    }
  }
  if (current.trim().length > 100) chunks.push(current.trim());
  return chunks.filter(c => c.length > 100);
}

function stripHtml(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--([\s\S]*?)-->/g, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}

async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const stats = fs.statSync(filePath);
  if (stats.size > MAX_FILE_BYTES) throw new Error('fichier > 30 MB');
  if (ext === '.pdf') {
    const data = await pdf(fs.readFileSync(filePath));
    return cleanText(data.text || '');
  }
  if (ext === '.docx') {
    const r = await mammoth.extractRawText({ path: filePath });
    return cleanText(r.value || '');
  }
  if (ext === '.html' || ext === '.htm') return cleanText(stripHtml(fs.readFileSync(filePath, 'utf-8')));
  return cleanText(fs.readFileSync(filePath, 'utf-8'));
}

function getAllFiles(dir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...getAllFiles(full));
    else if (SUPPORTED_EXT.includes(path.extname(e.name).toLowerCase())) out.push(full);
  }
  return out;
}

async function generateEmbeddings(texts, attempt = 0) {
  let res;
  try {
    res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${VOYAGE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'voyage-3', input: texts, input_type: 'document' }),
    });
  } catch (err) {
    // Panne réseau (fetch failed) : attendre et réessayer, jusqu'à ~10 min
    if (attempt < 8) {
      const delay = Math.min(3000 * Math.pow(2, attempt), 120000);
      console.log(`\n  🔁 réseau indisponible, nouvel essai dans ${Math.round(delay/1000)}s…`);
      await new Promise(r => setTimeout(r, delay));
      return generateEmbeddings(texts, attempt + 1);
    }
    throw err;
  }
  if ((res.status === 429 || res.status >= 500) && attempt < 8) {
    await new Promise(r => setTimeout(r, Math.min(2000 * Math.pow(2, attempt), 120000)));
    return generateEmbeddings(texts, attempt + 1);
  }
  if (!res.ok) throw new Error(`Voyage ${res.status} — ${await res.text()}`);
  const json = await res.json();
  return json.data.map(d => d.embedding);
}

async function main() {
  const idx = process.argv.indexOf('--dir');
  const ROOT = idx > -1 ? process.argv[idx + 1] : null;
  if (!ROOT || !fs.existsSync(ROOT)) {
    console.error('❌ Usage : node index_documents_v4.mjs --dir /chemin/dossier');
    process.exit(1);
  }

  const all = getAllFiles(ROOT);
  const ocrRoot = path.join(ROOT, OCR_DIR);

  // Fichiers OCR disponibles : rel (sans extension) -> chemin txt
  const ocrMap = new Map();
  for (const f of all) {
    if (f.startsWith(ocrRoot)) {
      const rel = f.slice(ocrRoot.length).replace(/\.txt$/i, '').normalize('NFC');
      ocrMap.set(rel, f);
    }
  }

  // Plan d'indexation : fichiers hors OCR_FO-UND ; un PDF couvert par un OCR txt est remplacé
  const plan = [];
  for (const f of all) {
    if (f.startsWith(ocrRoot)) continue;
    const relNoExt = f.slice(ROOT.length).replace(/^\/?/, '/').replace(/\.[^.]+$/, '').normalize('NFC');
    const ocrTxt = ocrMap.get(relNoExt);
    if (ocrTxt && /\.pdf$/i.test(f)) plan.push({ read: ocrTxt, source: path.basename(f), via: 'OCR' });
    else plan.push({ read: f, source: path.basename(f), via: 'direct' });
  }
  // Reprise : récupérer les sources déjà en base
  const deja = new Set();
  for (let i = 0; i < 40; i++) {
    const { data, error } = await supabase.from('documents').select('source').range(i*1000, i*1000+999);
    if (error || !data || data.length === 0) break;
    data.forEach(r => deja.add(r.source));
    if (data.length < 1000) break;
  }
  const avant = plan.length;
  const planFinal = plan.filter(p => !deja.has(p.source));
  plan.length = 0; plan.push(...planFinal);
  console.log(`📄 ${plan.length} documents à indexer (${avant - plan.length} déjà en base, ignorés) — dont ${plan.filter(p => p.via === 'OCR').length} via OCR\n`);

  const report = [['statut', 'via', 'chars', 'chunks', 'source'].join(';')];
  let totalChunks = 0, ok = 0, ignores = 0;

  for (const item of plan) {
    let text = '';
    try { text = await extractText(item.read); }
    catch (err) {
      report.push(['IGNORE_ERREUR', item.via, 0, 0, item.source + ' :: ' + err.message].join(';'));
      ignores++; continue;
    }
    if (!text || text.length < 100) {
      report.push(['IGNORE_VIDE', item.via, text.length, 0, item.source].join(';'));
      ignores++; continue;
    }
    const chunks = chunkText(text);
    if (chunks.length === 0) {
      report.push(['IGNORE_CHUNKS', item.via, text.length, 0, item.source].join(';'));
      ignores++; continue;
    }
    try {
      const rows = [];
      for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
        const batch = chunks.slice(i, i + BATCH_SIZE);
        const embeddings = await generateEmbeddings(batch);
        batch.forEach((content, j) => rows.push({
          source: item.source,
          content,
          embedding: embeddings[j],
          metadata: { file_path: item.read, via: item.via, chunk_index: i + j, total_chunks: chunks.length },
        }));
      }
      const { error } = await supabase.from('documents').insert(rows);
      if (error) throw error;
      totalChunks += rows.length; ok++;
      report.push(['OK', item.via, text.length, rows.length, item.source].join(';'));
      console.log(`✅ ${item.source} (${item.via}) — ${rows.length} chunks`);
    } catch (err) {
      report.push(['ECHEC_INDEX', item.via, text.length, 0, item.source + ' :: ' + err.message].join(';'));
      ignores++;
      console.log(`❌ ${item.source} — ${err.message}`);
    }
  }

  fs.writeFileSync(path.join(process.cwd(), 'rapport_indexation.csv'), report.join('\n'));
  console.log(`\n🎉 Terminé : ${ok} fichiers indexés, ${ignores} ignorés/échecs, ${totalChunks} chunks`);
  console.log('📋 Détail : rapport_indexation.csv');
}
main().catch(err => { console.error('❌ Fatal:', err); process.exit(1); });
