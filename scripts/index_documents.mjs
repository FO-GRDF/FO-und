#!/usr/bin/env node
/**
 * FO-UND — Script d'indexation des documents (v2)
 *
 * Usage :
 *   node index_documents.mjs --dir /chemin/vers/dossier
 *
 * Formats supportés : PDF, DOCX, TXT, MD, HTML
 * Embeddings : Voyage AI (voyage-3) via REST.
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
  console.error('   → Récupère une clé gratuite sur https://www.voyageai.com');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Configuration ─────────────────────────────────────────────────────────────
const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 100;
const BATCH_SIZE = 8;            // embeddings en parallèle (Voyage tier free = 3 RPM, plus large sur tier paid)
const SUPPORTED_EXT = ['.txt', '.md', '.pdf', '.docx', '.html', '.htm'];
const MAX_FILE_BYTES = 30 * 1024 * 1024; // skip > 30 MB

// ── Utilitaires ───────────────────────────────────────────────────────────────
function chunkText(text, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + size, text.length);
    chunks.push(text.slice(start, end).trim());
    start += size - overlap;
  }
  return chunks.filter(c => c.length > 50);
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

    if (ext === '.pdf') {
      const buf = fs.readFileSync(filePath);
      const data = await pdf(buf);
      return data.text || null;
    }
    if (ext === '.docx') {
      const result = await mammoth.extractRawText({ path: filePath });
      return result.value || null;
    }
    if (ext === '.html' || ext === '.htm') {
      return stripHtml(fs.readFileSync(filePath, 'utf-8'));
    }
    return fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    console.log(`  ⚠️  ${path.basename(filePath)} : ${err.message}`);
    return null;
  }
}

function getAllFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;            // skip .DS_Store, .git, etc.
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
  // Voyage REST — accepte un batch de textes en un appel
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${VOYAGE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'voyage-3',
      input: texts,
      input_type: 'document',
    }),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Voyage ${res.status} — ${errBody}`);
  }
  const json = await res.json();
  return json.data.map(d => d.embedding);
}

async function upsertChunks(chunks) {
  if (chunks.length === 0) return;
  const { error } = await supabase.from('documents').insert(chunks);
  if (error) throw error;
}

// ── Programme principal ───────────────────────────────────────────────────────
async function main() {
  const idx = process.argv.indexOf('--dir');
  const dirArg = idx > -1 ? process.argv[idx + 1] : null;
  if (!dirArg || !fs.existsSync(dirArg)) {
    console.error('❌ Dossier introuvable. Usage : node index_documents.mjs --dir /chemin/dossier');
    process.exit(1);
  }

  console.log(`\n🔍 Scan du dossier : ${dirArg}`);
  const files = getAllFiles(dirArg);
  console.log(`📄 ${files.length} fichiers indexables trouvés\n`);

  let totalChunks = 0;
  let processed = 0;
  let skipped = 0;

  for (const filePath of files) {
    const fileName = path.basename(filePath);
    const text = await readFile(filePath);
    if (!text || text.trim().length < 100) {
      skipped++;
      continue;
    }
    const chunks = chunkText(text);
    if (chunks.length === 0) {
      skipped++;
      continue;
    }

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
            metadata: {
              file_path: filePath,
              chunk_index: i + j,
              total_chunks: chunks.length,
            },
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
  console.log(`   ${totalChunks} chunks stockés dans Supabase\n`);
}

main().catch(err => {
  console.error('❌ Erreur fatale:', err);
  process.exit(1);
});
