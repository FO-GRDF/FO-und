-- ============================================================
-- FO-UND — Script SQL Supabase v2 (20/07/2026)
-- Recrée TOUT : table, index, recherche hybride v3
-- À exécuter dans : Supabase → SQL Editor → Run
-- ============================================================

create extension if not exists vector;

-- Table des chunks de documents
create table if not exists documents (
  id          bigserial primary key,
  source      text not null,
  content     text not null,
  embedding   vector(1024),
  metadata    jsonb default '{}',
  fts         tsvector generated always as (to_tsvector('french', content)) stored,
  created_at  timestamptz default now()
);

-- Index
create index if not exists documents_embedding_idx
  on documents using ivfflat (embedding vector_cosine_ops) with (lists = 100);
create index if not exists documents_fts_idx
  on documents using gin (fts);
create index if not exists documents_source_idx
  on documents (source);

-- ============================================================
-- Recherche hybride v3 : RRF (semantique + plein texte + nom de fichier)
-- Signature identique à celle appelée par backend/server.js
-- ============================================================
create or replace function hybrid_search_v3(
  query_text        text,
  query_embedding   vector(1024),
  match_count       int   default 15,
  full_text_weight  float default 2.0,
  semantic_weight   float default 1.0,
  filename_weight   float default 5.0,
  rrf_k             int   default 50
)
returns table (
  id bigint, source text, content text, metadata jsonb, similarity float
)
language sql stable
as $$
with kw as (
  -- mots-clés -> tsquery OR (recall élevé)
  select to_tsquery('french',
    coalesce(nullif(array_to_string(
      array(select w from regexp_split_to_table(trim(query_text), '\s+') w
            where length(w) > 1), ' | '), ''), 'aucunmotcle')
  ) as q
),
semantic as (
  select d.id, row_number() over (order by d.embedding <=> query_embedding) as rnk,
         1 - (d.embedding <=> query_embedding) as sim
  from documents d
  order by d.embedding <=> query_embedding
  limit 60
),
fulltext as (
  select d.id, row_number() over (order by ts_rank_cd(d.fts, kw.q) desc) as rnk
  from documents d, kw
  where d.fts @@ kw.q
  limit 60
),
filename as (
  select d.id, row_number() over (order by fn.hits desc) as rnk
  from documents d
  join lateral (
    select count(*) as hits
    from regexp_split_to_table(trim(query_text), '\s+') w
    where length(w) > 2 and d.source ilike '%' || w || '%'
  ) fn on fn.hits > 0
  limit 60
)
select d.id, d.source, d.content, d.metadata,
       coalesce(s.sim, 0) as similarity
from documents d
left join semantic s on s.id = d.id
left join fulltext f on f.id = d.id
left join filename fn on fn.id = d.id
where s.id is not null or f.id is not null or fn.id is not null
order by
  coalesce(semantic_weight / (rrf_k + s.rnk), 0) +
  coalesce(full_text_weight / (rrf_k + f.rnk), 0) +
  coalesce(filename_weight / (rrf_k + fn.rnk), 0) desc
limit match_count;
$$;

-- Sécurité
alter table documents enable row level security;
drop policy if exists "Lecture publique" on documents;
create policy "Lecture publique" on documents for select using (true);
