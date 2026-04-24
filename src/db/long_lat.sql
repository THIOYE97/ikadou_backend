-- ============================================================
-- IKADOU — long_lat.sql
-- Ajout / sécurisation des coordonnées géographiques terrain
-- + index utile pour filtres/cartographie
-- + index documents lié au stockage Cloudinary
-- Safe migration / idempotent
-- ============================================================

-- 1) Colonnes latitude / longitude
-- Le schéma principal les contient déjà normalement, mais on garde
-- IF NOT EXISTS pour éviter toute régression selon les environnements.

ALTER TABLE terrains
  ADD COLUMN IF NOT EXISTS latitude DECIMAL(10, 8);

ALTER TABLE terrains
  ADD COLUMN IF NOT EXISTS longitude DECIMAL(11, 8);

-- 2) Nettoyage défensif éventuel avant contraintes
-- Si un ancien environnement contient des valeurs hors bornes,
-- on les remet à NULL pour éviter l’échec de la migration.

UPDATE terrains
SET latitude = NULL
WHERE latitude IS NOT NULL
  AND (latitude < -90 OR latitude > 90);

UPDATE terrains
SET longitude = NULL
WHERE longitude IS NOT NULL
  AND (longitude < -180 OR longitude > 180);

-- 3) Contraintes de validité
-- On supprime puis recrée pour garantir le bon contenu même si
-- une version précédente existe déjà avec un autre nom / contenu.

ALTER TABLE terrains
  DROP CONSTRAINT IF EXISTS chk_terrains_latitude;

ALTER TABLE terrains
  ADD CONSTRAINT chk_terrains_latitude
  CHECK (latitude IS NULL OR (latitude >= -90 AND latitude <= 90));

ALTER TABLE terrains
  DROP CONSTRAINT IF EXISTS chk_terrains_longitude;

ALTER TABLE terrains
  ADD CONSTRAINT chk_terrains_longitude
  CHECK (longitude IS NULL OR (longitude >= -180 AND longitude <= 180));

-- 4) Index utile pour requêtes futures de proximité / filtres map
CREATE INDEX IF NOT EXISTS idx_terrains_lat_lng
  ON terrains(latitude, longitude);

-- 5) Index utile pour documents Cloudinary liés à un terrain
CREATE INDEX IF NOT EXISTS idx_documents_related_storage_key
  ON documents(related_type, related_id, storage_key);


