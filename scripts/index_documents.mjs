#!/usr/bin/env node
/**
 * FO-UND — Script d'indexation des documents
 *
 * Usage :
 *   node index_documents.mjs --dir /chemin/vers/dossier
 *
 * Formats supportés : PDF, DOCX, TXT, MD
 * Ce script découpe chaque fichier en chunks et les stocke
 * dans Supabase avec leurs embeddings sémantiques.
 */

import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';

dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Configuration ─────────────────────────────────────────────────────────────
const CHUNK_SIZE    = 800;   // caractères par chunk
const CHUNK_OVERLAP = 100;   // chevauchement entre chunks
const BATCH_SIZE    = 10;    // embeddings générés en parallèle
const SUPPORTED_EXT = ['.txt', '.md'];

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

async function readFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_EXT.includes(ext)) return null;
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function getAllFiles(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...getAllFiles(full));
    } else if (SUPPORTED_EXT.includes(path.extname(entry.name).toLowerCase())) {
      results.push(full);
    }
  }
  return results;
}

async function generateEmbedding(text) {
  const res = await anthropic.embeddings.create({
    model: 'voyage-3',
    input: text,
  });
  return res.embeddings[0].embedding;
}

async function upsertChunks(chunks) {
  const { error } = await supabase.from('documents').insert(chunks);
  if (error) throw error;
}

// ── Programme principal ───────────────────────────────────────────────────────

async function main() {
  const dirArg = process.argv.find(a => a.startsWith('--dir='))?.split('=')[1]
    || process.argv[process.argv.indexOf('--dir') + 1];

  if (!dirArg || !fs.existsSync(dirArg)) {
    console.error('❌ Dossier introuvable. Usage : node index_documents.mjs --dir /chemin/dossier');
    process.exit(1);
  }

  console.log(`\n🔍 Scan du dossier : ${dirArg}`);
  const files = getAllFiles(dirArg);
  console.log(`📄 ${files.length} fichiers trouvés\n`);

  let totalChunks = 0;
  let processed = 0;

  for (const filePath of files) {
    const text = await readFile(filePath);
    if (!text) continue;

    const fileName = path.basename(filePath);
    const chunks = chunkText(text);
    const rows = [];

    // Traiter les chunks par batch
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      const embeddings = await Promise.all(batch.map(generateEmbedding));

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

      process.stdout.write(`\r  📦 ${fileName} — chunk ${Math.min(i + BATCH_SIZE, chunks.length)}/${chunks.length}`);
    }

    await upsertChunks(rows);
    totalChunks += rows.length;
    processed++;
    console.log(`\n  ✅ ${fileName} — ${rows.length} chunks indexés`);
  }

  console.log(`\n🎉 Indexation terminée !`);
  console.log(`   ${processed} fichiers traités`);
  console.log(`   ${totalChunks} chunks stockés dans Supabase\n`);
}

main().catch(err => {
  console.error('❌ Erreur fatale:', err);
  process.exit(1);
});
