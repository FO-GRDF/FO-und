#!/usr/bin/env node
/**
 * FO-UND — Indexation des documents (v3)
 * v3 : nettoyage des patterns parasites (DocuSign, symboles répétés)
 *      + chunking respectant les paragraphes
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

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ SUPABASE_URL ou SUPABASE_SERVICE_KEY manquant dans .env');
  process.exit(1);
}
if (!VOYAGE_KEY) {
  console.error('❌ VOYAGE_API_KEY manquant dans .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const CHUNK_SIZE = 1000;          // un peu plus large pour porter plus de contexte
const CHUNK_OVERLAP = 150;
const BATCH_SIZE = 8;
const SUPPORTED_EXT = ['.txt', '.md', '.pdf', '.docx', '.html', '.htm'];
const MAX_FILE_BYTES = 30 * 1024 * 1024;

// ── Nettoyage des textes extraits ─────────────────────────────────────────────
function cleanText(text) {
  if (!text) return '';
  return text
    // DocuSign Envelope ID répétés (énorme bruit dans les accords signés)
    .replace(/DocuSign Envelope ID:\s*[A-F0-9-]+/gi, ' ')
    // Symboles décoratifs répétés (cadres, listes graphiques)
    .replace(/[◼➢▪✓●○■□◆◇▶►•·]\s*[◼➢▪✓●○■□◆◇▶►•·\s]{2,}/g, ' ')
    // Lignes de tirets / points / égal
    .replace(/(?:[\s]*[-_=*~–—\.]){4,}/g, ' ')
    // Numéros de page type "Page 12 sur 45" / "12/45"
    .replace(/Page\s+\d+\s+(?:sur|of|\/)\s+\d+/gi, ' ')
    // Email Cloudflare obfusqué
    .replace(/\[email[\s]*protected\]/gi, ' ')
    // Espaces multiples / tabulations
    .replace(/[ \t]{2,}/g, ' ')
    // Trois retours à la ligne ou plus → deux
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Chunking respectant paragraphes ───────────────────────────────────────────
function chunkText(text, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  if (!text) return [];
  const chunks = [];
  // Découper d'abord par paragraphes (double newline)
  const paragraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(p => p.length > 0);

  let current = '';
  for (const para of paragraphs) {
    if (current.length === 0) {
      current = para;
    } else if (current.length + para.length + 2 <= size) {
      current += '\n\n' + para;
    } else {
      // Flush current chunk
      if (current.length > 100) chunks.push(current);
      // Démarrer un nouveau chunk avec un overlap
      const tail = current.slice(-overlap);
      current = tail + '\n\n' + para;
      // Si un seul paragraphe excède la taille, le splitter brutalement
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
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--([\s\S]*?)-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function readFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_EXT.includes(ext)) return null;

  try {
    const stats = fs.statSync(filePath);
    if (stats.size > MAX_FILE_BYTES) {
      console.log(`  ⏭  ${path.basename(filePath)} ignoré (>${MAX_FILE_BYTES / 1024 / 1024} MB)`);
      return null;
    }

    let raw = '';
    if (ext === '.pdf') {
      const buf = fs.readFileSync(filePath);
      const data = await pdf(buf);
      raw = data.text || '';
    } else if (ext === '.docx') {
      const result = await mammoth.extractRawText({ path: filePath });
      raw = result.value || '';
    } else if (ext === '.html' || ext === '.htm') {
      raw = stripHtml(fs.readFileSync(filePath, 'utf-8'));
    } else {
      raw = fs.readFileSync(filePath, 'utf-8');
    }
    return cleanText(raw);
  } catch (err) {
    console.log(`  ⚠️  ${path.basename(filePath)} : ${err.message}`);
    return null;
  }
}

function getAllFiles(dir) {
  const results = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return results; }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...getAllFiles(full));
    } else if (SUPPORTED_EXT.includes(path.extname(entry.name).toLowerCase())) {
      results.push(full);
    }
  }
  return results;
}

async function generateEmbeddings(texts) {
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${VOYAGE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'voyage-3', input: texts, input_type: 'document' }),
  });
  if (!res.ok) throw new Error(`Voyage ${res.status} — ${await res.text()}`);
  const json = await res.json();
  return json.data.map(d => d.embedding);
}

async function upsertChunks(chunks) {
  if (chunks.length === 0) return;
  const { error } = await supabase.from('documents').insert(chunks);
  if (error) throw error;
}

async function main() {
  const idx = process.argv.indexOf('--dir');
  const dirArg = idx > -1 ? process.argv[idx + 1] : null;
  if (!dirArg || !fs.existsSync(dirArg)) {
    console.error('❌ Dossier introuvable. Usage : node index_documents.mjs --dir /chemin/dossier');
    process.exit(1);
  }

  console.log(`\n🔍 Scan : ${dirArg}`);
  const files = getAllFiles(dirArg);
  console.log(`📄 ${files.length} fichiers indexables trouvés\n`);

  let totalChunks = 0;
  let processed = 0;
  let skipped = 0;

  for (const filePath of files) {
    const fileName = path.basename(filePath);
    const text = await readFile(filePath);
    if (!text || text.trim().length < 100) { skipped++; continue; }
    const chunks = chunkText(text);
    if (chunks.length === 0) { skipped++; continue; }

    const rows = [];
    try {
      for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
        const batch = chunks.slice(i, i + BATCH_SIZE);
        const embeddings = await generateEmbeddings(batch);
        batch.forEach((content, j) => {
          rows.push({
            source: fileName,
            content,
            embedding: embeddings[j],
            metadata: { file_path: filePath, chunk_index: i + j, total_chunks: chunks.length },
          });
        });
        process.stdout.write(`\r  📦 ${fileName} — ${Math.min(i + BATCH_SIZE, chunks.length)}/${chunks.length}`);
      }
      await upsertChunks(rows);
      totalChunks += rows.length;
      processed++;
      console.log(`\n  ✅ ${fileName} — ${rows.length} chunks`);
    } catch (err) {
      console.log(`\n  ❌ ${fileName} — ${err.message}`);
      skipped++;
    }
  }

  console.log(`\n🎉 Indexation terminée`);
  console.log(`   ${processed} fichiers indexés / ${skipped} ignorés`);
  console.log(`   ${totalChunks} chunks stockés\n`);
}

main().catch(err => { console.error('❌ Fatal:', err); process.exit(1); });
