const { query } = require('../data/db');
const HttpError = require('../utils/httpError');

const buildMainImage = (images) => {
  if (!Array.isArray(images) || images.length === 0) return null;
  return images.find((img) => img.is_main) || images[0] || null;
};

const listTerrains = async ({
  search,
  min_price,
  max_price,
  min_surface,
  max_surface,
  location,
  zone_id,
  page = 1,
  limit = 20,
  sort = 'created_at',
  order = 'desc',
}) => {
  const params = [];
  const conditions = [`t.status = 'published'`];

  if (search) {
    params.push(`%${search}%`);
    const n = params.length;
    conditions.push(`(t.title ILIKE $${n} OR t.ref ILIKE $${n} OR t.location ILIKE $${n})`);
  }

  if (location) {
    params.push(`%${location}%`);
    conditions.push(`t.location ILIKE $${params.length}`);
  }

  if (zone_id) {
    params.push(zone_id);
    conditions.push(`t.zone_id = $${params.length}`);
  }

  if (min_price) {
    params.push(Number(min_price));
    conditions.push(`t.price >= $${params.length}`);
  }

  if (max_price) {
    params.push(Number(max_price));
    conditions.push(`t.price <= $${params.length}`);
  }

  if (min_surface) {
    params.push(Number(min_surface));
    conditions.push(`t.surface_m2 >= $${params.length}`);
  }

  if (max_surface) {
    params.push(Number(max_surface));
    conditions.push(`t.surface_m2 <= $${params.length}`);
  }

  const allowedSort = ['created_at', 'price', 'surface_m2', 'title', 'ref'];
  const sortCol = allowedSort.includes(sort) ? sort : 'created_at';
  const sortOrder = order === 'asc' ? 'ASC' : 'DESC';

  const where = `WHERE ${conditions.join(' AND ')}`;
  const offset = (Number(page) - 1) * Number(limit);

  const countRes = await query(
    `SELECT COUNT(*)::int AS total
     FROM terrains t
     ${where}`,
    params
  );

  const total = countRes.rows[0]?.total || 0;

  params.push(Number(limit), offset);

  const rows = await query(
    `SELECT
       t.id, t.ref, t.title, t.price, t.currency, t.surface_m2,
       t.location, t.latitude, t.longitude, t.availability, t.images,
       z.id AS zone_id, z.name AS zone_name, z.region AS zone_region
     FROM terrains t
     LEFT JOIN zones z ON z.id = t.zone_id
     ${where}
     ORDER BY t.${sortCol} ${sortOrder}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  const data = rows.rows.map((row) => ({
    id: row.id,
    ref: row.ref,
    title: row.title,
    price: row.price,
    currency: row.currency,
    surfaceM2: row.surface_m2,
    location: row.location,
    latitude: row.latitude,
    longitude: row.longitude,
    availability: row.availability,
    zone: row.zone_id ? {
      id: row.zone_id,
      name: row.zone_name,
      region: row.zone_region,
    } : null,
    mainImage: buildMainImage(row.images),
  }));

  return {
    data,
    meta: {
      total,
      page: Number(page),
      limit: Number(limit),
      pages: Math.ceil(total / Number(limit)),
    },
  };
};

const getTerrainById = async (terrainId) => {
  const result = await query(
    `SELECT t.*, z.name AS zone_name, z.region AS zone_region
     FROM terrains t
     LEFT JOIN zones z ON z.id = t.zone_id
     WHERE t.id = $1
       AND t.status = 'published'`,
    [terrainId]
  );

  if (!result.rows.length) {
    throw HttpError.notFound('Terrain introuvable');
  }

  const terrain = result.rows[0];

  const docs = await query(
    `SELECT id, name, type, created_at
     FROM documents
     WHERE related_type = 'terrain'
       AND related_id = $1
     ORDER BY created_at DESC`,
    [terrainId]
  );

  return {
    id: terrain.id,
    ref: terrain.ref,
    title: terrain.title,
    description: terrain.description,
    price: terrain.price,
    currency: terrain.currency,
    surfaceM2: terrain.surface_m2,
    location: terrain.location,
    latitude: terrain.latitude,
    longitude: terrain.longitude,
    availability: terrain.availability,
    amenities: terrain.amenities || [],
    images: terrain.images || [],
    zone: terrain.zone_id ? {
      id: terrain.zone_id,
      name: terrain.zone_name,
      region: terrain.zone_region,
    } : null,
    documents: docs.rows,
    reassurance: {
      availabilityLabel:
        terrain.availability === 'available' ? 'Disponible'
        : terrain.availability === 'reserved' ? 'Réservé'
        : 'Indisponible',
      badges: [
        'Terrain publié',
        Array.isArray(terrain.images) && terrain.images.length ? 'Photos disponibles' : null,
        terrain.location ? 'Localisation renseignée' : null,
      ].filter(Boolean),
    },
  };
};

const listMapTerrains = async (filters = {}) => {
  const result = await listTerrains({ ...filters, limit: filters.limit || 200 });
  return result.data.map((item) => ({
    id: item.id,
    title: item.title,
    price: item.price,
    currency: item.currency,
    surfaceM2: item.surfaceM2,
    location: item.location,
    latitude: item.latitude,
    longitude: item.longitude,
    mainImage: item.mainImage,
  }));
};

module.exports = {
  listTerrains,
  getTerrainById,
  listMapTerrains,
};