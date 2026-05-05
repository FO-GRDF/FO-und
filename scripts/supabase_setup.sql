-- ============================================================
-- FO-UND — Script SQL Supabase
-- À exécuter dans : Supabase → SQL Editor
-- ============================================================

-- 1. Activer l'extension pgvector (recherche vectorielle)
create extension if not exists vector;

-- 2. Table des documents indexés
create table if not exists documents (
  id          bigserial primary key,
  source      text not null,           -- nom du fichier source
  content     text not null,           -- contenu du chunk
  embedding   vector(1024),            -- vecteur sémantique
  metadata    jsonb default '{}',      -- catégorie, date, etc.
  created_at  timestamptz default now()
);

-- 3. Index pour accélérer la recherche vectorielle
create index if not exists documents_embedding_idx
  on documents
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- 4. Fonction de recherche sémantique
create or replace function match_documents(
  query_embedding vector(1024),
  match_threshold float default 0.7,
  match_count     int   default 5
)
returns table (
  id       bigint,
  source   text,
  content  text,
  metadata jsonb,
  similarity float
)
language sql stable
as $$
  select
    id,
    source,
    content,
    metadata,
    1 - (embedding <=> query_embedding) as similarity
  from documents
  where 1 - (embedding <=> query_embedding) > match_threshold
  order by embedding <=> query_embedding
  limit match_count;
$$;

-- 5. Activer Row Level Security
alter table documents enable row level security;

-- Permettre la lecture publique (le backend utilise la service_key)
create policy "Lecture publique"
  on documents for select
  using (true);

-- ============================================================
-- ✅ Script terminé — la base est prête pour l'indexation
-- ============================================================
