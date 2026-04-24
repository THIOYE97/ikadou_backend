const { query, transaction } = require('../data/db');
const HttpError = require('../utils/httpError');
const {
  saveImage,
  saveDocument,
  deleteImage,
  deleteDocument,
} = require('./ImageService');

const STATUS_TRANSITIONS = {
  draft: ['published', 'unavailable'],
  published: ['reserved', 'unavailable', 'draft'],
  reserved: ['published', 'sold', 'unavailable'],
  sold: [],
  unavailable: ['draft', 'published'],
};

const SENSITIVE_TRANSITIONS = ['sold'];

async function getTerrainOrThrow(terrainId) {
  const result = await query(
    `SELECT * FROM terrains WHERE id = $1`,
    [terrainId]
  );

  if (!result.rows.length) {
    throw HttpError.notFound('Terrain introuvable');
  }

  return result.rows[0];
}

async function appendTerrainHistory({
  terrainId,
  field,
  oldValue = null,
  newValue = null,
  comment = null,
  userId = null,
}) {
  await query(
    `INSERT INTO terrain_history (terrain_id, field, old_value, new_value, comment, user_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      terrainId,
      field,
      oldValue === null ? null : JSON.stringify(oldValue),
      newValue === null ? null : JSON.stringify(newValue),
      comment,
      userId,
    ]
  );
}

async function listTerrains({
  search,
  status,
  availability,
  zone_id,
  is_featured,
  page = 1,
  limit = 20,
  sort = 'created_at',
  order = 'desc',
}) {
  const params = [];
  const conditions = [];

  if (search) {
    params.push(`%${search}%`);
    const n = params.length;
    conditions.push(`(t.title ILIKE $${n} OR t.ref ILIKE $${n} OR t.location ILIKE $${n})`);
  }
  if (status) {
    params.push(status);
    conditions.push(`t.status = $${params.length}`);
  }
  if (availability) {
    params.push(availability);
    conditions.push(`t.availability = $${params.length}`);
  }
  if (zone_id) {
    params.push(zone_id);
    conditions.push(`t.zone_id = $${params.length}`);
  }
  if (is_featured === 'true') {
    conditions.push(`t.is_featured = TRUE`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const allowedSort = ['created_at', 'price', 'surface_m2', 'title', 'ref'];
  const sortCol = allowedSort.includes(sort) ? sort : 'created_at';
  const sortOrder = order === 'asc' ? 'ASC' : 'DESC';
  const safePage = Math.max(1, Number(page));
  const safeLimit = Math.max(1, Number(limit));
  const offset = (safePage - 1) * safeLimit;

  const countRes = await query(`SELECT COUNT(*) FROM terrains t ${where}`, params);
  const total = parseInt(countRes.rows[0].count, 10);

  params.push(safeLimit, offset);
  const rows = await query(
    `SELECT
       t.id, t.ref, t.title, t.price, t.currency, t.surface_m2,
       t.location, t.latitude, t.longitude,
       t.status, t.availability, t.is_featured,
       t.created_at, t.updated_at,
       z.name AS zone_name
     FROM terrains t
     LEFT JOIN zones z ON t.zone_id = z.id
     ${where}
     ORDER BY t.${sortCol} ${sortOrder}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return {
    data: rows.rows,
    meta: {
      total,
      page: safePage,
      limit: safeLimit,
      pages: Math.ceil(total / safeLimit),
    },
  };
}

async function createTerrain({
  ref,
  title,
  description,
  price,
  currency = 'XOF',
  surfaceM2,
  location,
  zoneId,
  latitude,
  longitude,
  status = 'draft',
  isFeatured = false,
  amenities = [],
  images = [],

  // 🔥 NOUVEAUX
  environmentBenefits = [],
  trustItems = [],
  agencyName,
  notaryName,
  notaryPhone,
  ninacad,
  catalogTags = [],
  terrainUse = null,
  catalogBucket = null,
  displayInDiscovery = false,

  userId,
}) {
  const existing = await query(`SELECT id FROM terrains WHERE ref = $1`, [ref]);
  if (existing.rows.length) {
    throw HttpError.conflict(`La référence "${ref}" est déjà utilisée`);
  }

  const result = await query(
  `INSERT INTO terrains
     (
      ref, title, description, price, currency, surface_m2, location, zone_id,
      latitude, longitude, status, is_featured,
      amenities, images,
      environment_benefits, trust_items,
      agency_name, notary_name, notary_phone, ninacad,
      catalog_tags,
      terrain_use,
      catalog_bucket,
      display_in_discovery,
      created_by
     )
   VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,
      $9,$10,$11,$12,
      $13,$14,
      $15,$16,
      $17,$18,$19,$20,
      $21,$22,$23,$24,$25
   )
   RETURNING *`,
  [
    ref,
    title,
    description || null,
    price,
    currency,
    surfaceM2 ?? null,
    location || null,
    zoneId || null,

    latitude ?? null,
    longitude ?? null,
    status,
    isFeatured,

    JSON.stringify(amenities || []),
    JSON.stringify(images || []),

    JSON.stringify(environmentBenefits || []),
    JSON.stringify(trustItems || []),

    agencyName || null,
    notaryName || null,
    notaryPhone || null,
    ninacad || null,

    JSON.stringify(catalogTags || []),

    terrainUse || null,
    catalogBucket || null,
    !!displayInDiscovery,

    userId,
  ]
);
  return result.rows[0];
}

async function getTerrainDetail(terrainId) {
  const result = await query(
    `SELECT t.*, z.name AS zone_name, z.region AS zone_region
     FROM terrains t
     LEFT JOIN zones z ON t.zone_id = z.id
     WHERE t.id = $1`,
    [terrainId]
  );

  if (!result.rows.length) {
    throw HttpError.notFound('Terrain introuvable');
  }

  const [history, docs] = await Promise.all([
    query(
      `SELECT th.*, u.first_name || ' ' || u.last_name AS author
       FROM terrain_history th
       LEFT JOIN internal_users u ON th.user_id = u.id
       WHERE th.terrain_id = $1
       ORDER BY th.created_at DESC`,
      [terrainId]
    ),
    query(
      `SELECT id, name, original_name, type, mime_type, size_bytes, url, storage_key, created_at
       FROM documents
       WHERE related_type = 'terrain'
         AND related_id = $1
         AND (name IS NULL OR name NOT LIKE 'Terrain image - %')
       ORDER BY created_at DESC`,
      [terrainId]
    ),
  ]);

  return {
  ...result.rows[0],

  environmentBenefits: result.rows[0].environment_benefits || [],
  trustItems: result.rows[0].trust_items || [],

  agencyName: result.rows[0].agency_name,
  notaryName: result.rows[0].notary_name,
  notaryPhone: result.rows[0].notary_phone,
  ninacad: result.rows[0].ninacad,

  history: history.rows,
  documents: docs.rows,
  catalogTags: result.rows[0].catalog_tags || [],
terrainUse: result.rows[0].terrain_use || null,
catalogBucket: result.rows[0].catalog_bucket || null,
displayInDiscovery: !!result.rows[0].display_in_discovery,
};
}

async function updateTerrain(terrainId, payload, userId) {
  const existing = await getTerrainOrThrow(terrainId);

  const {
  title,
  description,
  price,
  currency,
  surfaceM2,
  location,
  zoneId,
  latitude,
  longitude,
  isFeatured,
  amenities,
  images,
  environmentBenefits,
  trustItems,
  agencyName,
  notaryName,
  notaryPhone,
  ninacad,
  catalogTags,
  terrainUse,
  catalogBucket,
  displayInDiscovery,
} = payload;

  const fields = [];
  const params = [];
  const changed = {};

  const set = (col, val, previous) => {
    if (val !== undefined) {
      params.push(typeof val === 'object' ? JSON.stringify(val) : val);
      fields.push(`${col} = $${params.length}`);
      changed[col] = { old: previous, next: val };
    }
  };

  set('title', title, existing.title);
  set('description', description, existing.description);
  set('price', price, existing.price);
  set('currency', currency, existing.currency);
  set('surface_m2', surfaceM2, existing.surface_m2);
  set('location', location, existing.location);
  set('zone_id', zoneId, existing.zone_id);
  set('latitude', latitude, existing.latitude);
  set('longitude', longitude, existing.longitude);
  set('is_featured', isFeatured, existing.is_featured);
  set('amenities', amenities, existing.amenities);
  set('images', images, existing.images);
  set('environment_benefits', environmentBenefits, existing.environment_benefits);
  set('trust_items', trustItems, existing.trust_items);
  set('agency_name', agencyName, existing.agency_name);
  set('notary_name', notaryName, existing.notary_name);
  set('notary_phone', notaryPhone, existing.notary_phone);
  set('ninacad', ninacad, existing.ninacad);
  set('catalog_tags', catalogTags, existing.catalog_tags);
set('terrain_use', terrainUse, existing.terrain_use);
set('catalog_bucket', catalogBucket, existing.catalog_bucket);
set('display_in_discovery', displayInDiscovery, existing.display_in_discovery);

  if (!fields.length) {
    throw HttpError.badRequest('Aucun champ à mettre à jour');
  }

  params.push(terrainId);
  const result = await query(
    `UPDATE terrains
     SET ${fields.join(', ')}, updated_at = NOW()
     WHERE id = $${params.length}
     RETURNING *`,
    params
  );

  const updated = result.rows[0];

  await appendTerrainHistory({
    terrainId,
    field: 'updated',
    oldValue: changed,
    newValue: { id: updated.id, updated_at: updated.updated_at },
    comment: `Champs modifiés: ${Object.keys(changed).join(', ')}`,
    userId,
  });

  return updated;
}

async function changeTerrainStatus({ terrainId, status, reason = null, userId, userRole }) {
  const existing = await getTerrainOrThrow(terrainId);
  const allowed = STATUS_TRANSITIONS[existing.status] || [];

  if (!allowed.includes(status)) {
    throw HttpError.badRequest(`Transition invalide: ${existing.status} -> ${status}`);
  }

  if (SENSITIVE_TRANSITIONS.includes(status) && !['admin', 'super_admin'].includes(userRole)) {
    throw HttpError.forbidden('Transition réservée aux administrateurs');
  }

  const availabilityByStatus = {
    published: 'available',
    reserved: 'reserved',
    sold: 'sold',
  };

  const nextAvailability = availabilityByStatus[status] || existing.availability;

  const result = await query(
    `UPDATE terrains
     SET status = $1,
         availability = $2,
         updated_at = NOW()
     WHERE id = $3
     RETURNING *`,
    [status, nextAvailability, terrainId]
  );

  await appendTerrainHistory({
    terrainId,
    field: 'status',
    oldValue: { status: existing.status, availability: existing.availability },
    newValue: { status: result.rows[0].status, availability: result.rows[0].availability },
    comment: reason,
    userId,
  });

  return result.rows[0];
}

async function getTerrainImages(terrainId) {
  const terrain = await getTerrainOrThrow(terrainId);
  return terrain.images || [];
}

async function addTerrainImages({ terrainId, files, userId }) {
  const terrain = await getTerrainOrThrow(terrainId);

  if (!files || files.length === 0) {
    throw HttpError.badRequest('Aucun fichier reçu');
  }

  const currentImages = terrain.images || [];

  const saved = await Promise.all(
    files.map(async (file, index) => {
      const preset = index === 0 && currentImages.length === 0
        ? 'terrain_main'
        : 'terrain_gallery';

      const result = await saveImage(file.buffer, preset, 'terrains');

      return {
        url: result.url,
        storage_key: result.storageKey,
        width: result.width,
        height: result.height,
        size_bytes: result.sizeBytes,
        original_name: file.originalname,
        is_main: index === 0 && currentImages.length === 0,
        uploaded_at: new Date().toISOString(),
      };
    })
  );

  const updatedImages = [...currentImages, ...saved];

  await transaction(async (client) => {
    await client.query(
      `UPDATE terrains SET images = $1, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(updatedImages), terrainId]
    );

    await client.query(
      `INSERT INTO terrain_history (terrain_id, field, new_value, comment, user_id)
       VALUES ($1, 'images', $2, $3, $4)`,
      [
        terrainId,
        JSON.stringify({ count: updatedImages.length, added: saved.length }),
        `Upload: ${files.map((f) => f.originalname).join(', ')}`,
        userId,
      ]
    );
  });

  for (const img of saved) {
    await query(
      `INSERT INTO documents
         (name, original_name, type, mime_type, size_bytes, url, storage_key, related_type, related_id, uploaded_by)
       VALUES ($1, $2, 'other', 'image/webp', $3, $4, $5, 'terrain', $6, $7)`,
      [
        `Terrain image - ${img.original_name}`,
        img.original_name,
        img.size_bytes,
        img.url,
        img.storage_key,
        terrainId,
        userId,
      ]
    );
  }

  return {
    uploaded: saved,
    total: updatedImages.length,
  };
}

async function reorderTerrainImages({ terrainId, orderedUrls, userId = null }) {
  if (!Array.isArray(orderedUrls)) {
    throw HttpError.badRequest('orderedUrls array requis');
  }

  const terrain = await getTerrainOrThrow(terrainId);
  const current = terrain.images || [];

  const reordered = orderedUrls
    .map((url) => current.find((img) => img.url === url))
    .filter(Boolean);

  if (reordered.length > 0) {
    reordered.forEach((img, i) => {
      img.is_main = i === 0;
    });
  }

  await query(
    `UPDATE terrains SET images = $1, updated_at = NOW() WHERE id = $2`,
    [JSON.stringify(reordered), terrainId]
  );

  await appendTerrainHistory({
    terrainId,
    field: 'images_reordered',
    newValue: reordered.map((img) => ({ url: img.url, is_main: img.is_main })),
    userId,
  });

  return reordered;
}

async function deleteTerrainImage({ terrainId, storageKey, userId }) {
  if (!storageKey) {
    throw HttpError.badRequest('storageKey requis');
  }

  const terrain = await getTerrainOrThrow(terrainId);
  const current = terrain.images || [];
  const removed = current.find((img) => img.storage_key === storageKey);

  if (!removed) {
    throw HttpError.notFound('Image introuvable');
  }

  const filtered = current.filter((img) => img.storage_key !== storageKey);

  if (filtered.length > 0 && !filtered.some((img) => img.is_main)) {
    filtered[0].is_main = true;
  }

  await transaction(async (client) => {
    await client.query(
      `UPDATE terrains SET images = $1, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(filtered), terrainId]
    );

    await client.query(
      `DELETE FROM documents
       WHERE related_type = 'terrain' AND related_id = $1 AND storage_key = $2`,
      [terrainId, storageKey]
    );

    await client.query(
      `INSERT INTO terrain_history (terrain_id, field, old_value, new_value, comment, user_id)
       VALUES ($1, 'image_deleted', $2, $3, $4, $5)`,
      [
        terrainId,
        JSON.stringify(removed),
        JSON.stringify({ remaining: filtered.length }),
        `Suppression image ${removed.original_name || storageKey}`,
        userId,
      ]
    );
  });

  await deleteImage(storageKey);

  return {
    deleted: true,
    total: filtered.length,
    images: filtered,
  };
}

async function setTerrainMainImage({ terrainId, storageKey, userId = null }) {
  const terrain = await getTerrainOrThrow(terrainId);
  const current = terrain.images || [];

  if (!current.length) {
    throw HttpError.badRequest('Aucune image disponible');
  }

  let found = false;
  const updated = current.map((img) => {
    const isMain = img.storage_key === storageKey;
    if (isMain) found = true;
    return { ...img, is_main: isMain };
  });

  if (!found) {
    throw HttpError.notFound('Image introuvable');
  }

  await query(
    `UPDATE terrains SET images = $1, updated_at = NOW() WHERE id = $2`,
    [JSON.stringify(updated), terrainId]
  );

  await appendTerrainHistory({
    terrainId,
    field: 'main_image_changed',
    newValue: { storage_key: storageKey },
    userId,
  });

  return updated;
}

function inferDocumentType(mimeType = '', originalName = '') {
  const ext = (originalName.split('.').pop() || '').toLowerCase();

  if (mimeType === 'application/pdf') return 'contract';
  if (['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'].includes(ext)) return 'other';
  return 'other';
}

async function addTerrainDocuments({ terrainId, files, userId }) {
  await getTerrainOrThrow(terrainId);

  if (!files || files.length === 0) {
    throw HttpError.badRequest('Aucun fichier reçu');
  }

  const uploaded = [];

  for (const file of files) {
    const saved = await saveDocument({
      inputBuffer: file.buffer,
      originalName: file.originalname,
      mimeType: file.mimetype,
      subdir: 'terrains/documents',
    });

    const docRes = await query(
      `INSERT INTO documents
         (name, original_name, type, mime_type, size_bytes, url, storage_key, related_type, related_id, uploaded_by, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'terrain', $8, $9, $10)
       RETURNING id, name, original_name, type, mime_type, size_bytes, url, storage_key, status, created_at`,
      [
        file.originalname,
        file.originalname,
        'other',
        saved.mimeType,
        saved.sizeBytes,
        saved.url,
        saved.storageKey,
        terrainId,
        userId,
        saved.resourceType, // on s’en sert comme méta simple ici
      ]
    );

    uploaded.push(docRes.rows[0]);
  }

  await appendTerrainHistory({
    terrainId,
    field: 'documents',
    newValue: { added: uploaded.length },
    comment: `Ajout document(s): ${files.map((f) => f.originalname).join(', ')}`,
    userId,
  });

  return { uploaded };
}

async function getTerrainDocuments(terrainId) {
  await getTerrainOrThrow(terrainId);

  const docs = await query(
    `SELECT id, name, original_name, type, mime_type, size_bytes, url, storage_key, created_at
     FROM documents
     WHERE related_type = 'terrain'
       AND related_id = $1
       AND (name IS NULL OR name NOT LIKE 'Terrain image - %')
     ORDER BY created_at DESC`,
    [terrainId]
  );

  return docs.rows;
}

async function deleteTerrainDocument({ terrainId, documentId, userId }) {
  if (!documentId) {
    throw HttpError.badRequest('documentId requis');
  }

  await getTerrainOrThrow(terrainId);

  const docRes = await query(
    `SELECT id, name, original_name, mime_type, storage_key, status
     FROM documents
     WHERE id = $1
       AND related_type = 'terrain'
       AND related_id = $2`,
    [documentId, terrainId]
  );

  if (!docRes.rows.length) {
    throw HttpError.notFound('Document introuvable');
  }

  const doc = docRes.rows[0];
  const resourceType = doc.status === 'image' ? 'image' : 'raw';

  await transaction(async (client) => {
    await client.query(`DELETE FROM documents WHERE id = $1`, [documentId]);

    await client.query(
      `INSERT INTO terrain_history (terrain_id, field, old_value, new_value, comment, user_id)
       VALUES ($1, 'document_deleted', $2, $3, $4, $5)`,
      [
        terrainId,
        JSON.stringify(doc),
        JSON.stringify({ deleted: true }),
        `Suppression document ${doc.original_name || doc.name}`,
        userId,
      ]
    );
  });

  await deleteDocument(doc.storage_key, resourceType);

  return { deleted: true, id: documentId };
}

module.exports = {
  STATUS_TRANSITIONS,
  SENSITIVE_TRANSITIONS,
  listTerrains,
  createTerrain,
  getTerrainDetail,
  updateTerrain,
  changeTerrainStatus,
  getTerrainImages,
  addTerrainImages,
  reorderTerrainImages,
  deleteTerrainImage,
  setTerrainMainImage,
  addTerrainDocuments,
  getTerrainDocuments,
  deleteTerrainDocument,
};