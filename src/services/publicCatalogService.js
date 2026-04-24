const { query } = require('../data/db');
const HttpError = require('../utils/httpError');

const buildMainImage = (images) => {
  if (!Array.isArray(images) || images.length === 0) return null;
  return images.find((img) => img.is_main) || images[0] || null;
};

const formatMoney = (amount, currency = 'XOF') => {
  if (amount === null || amount === undefined) return null;

  try {
    return new Intl.NumberFormat('fr-FR', {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(Number(amount));
  } catch {
    return `${amount} ${currency}`;
  }
};

const formatSurface = (surface) => {
  if (surface === null || surface === undefined) return null;
  return `${surface} m²`;
};

const availabilityLabel = (availability) => {
  if (availability === 'available') return 'Disponible';
  if (availability === 'reserved') return 'Réservé';
  return 'Indisponible';
};

const hasCoordinates = (latitude, longitude) =>
  latitude !== null &&
  latitude !== undefined &&
  longitude !== null &&
  longitude !== undefined;

const normalizeImages = (images) => (Array.isArray(images) ? images : []);
const normalizeAmenities = (amenities) => (Array.isArray(amenities) ? amenities : []);

const buildBadges = ({ images, location, docs = [], latitude, longitude }) => {
  const badges = [
    docs.some((d) => d.type === 'title_deed') ? 'Titre foncier' : null,
    docs.some((d) => d.type === 'survey_plan') ? 'Plan cadastral' : null,
    docs.some((d) => d.type === 'contract') ? 'Contrat disponible' : null,
    Array.isArray(images) && images.length ? 'Photos disponibles' : null,
    location ? 'Localisation renseignée' : null,
    hasCoordinates(latitude, longitude) ? 'Coordonnées GPS' : null,
    'Paiement échelonné',
  ].filter(Boolean);

  return [...new Set(badges)];
};

const mapDocument = (doc) => ({
  id: doc.id,
  name: doc.name,
  originalName: doc.original_name || null,
  type: doc.type,
  mimeType: doc.mime_type || null,
  sizeBytes: doc.size_bytes || null,
  url: doc.url || null,
  isPreviewable:
    doc.mime_type === 'application/pdf' ||
    (doc.mime_type || '').startsWith('image/'),
  createdAt: doc.created_at,
});

const buildListItem = (row) => {
  const images = normalizeImages(row.images);
  const mainImage = buildMainImage(images);
  const catalogTags = normalizeJsonArray(row.catalog_tags);

  return {
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
    zone: row.zone_id
      ? {
          id: row.zone_id,
          name: row.zone_name,
          region: row.zone_region,
        }
      : null,
    mainImage,
    images,

    formattedPrice: formatMoney(row.price, row.currency),
    formattedSurface: formatSurface(row.surface_m2),
    availabilityLabel: availabilityLabel(row.availability),
    hasCoordinates: hasCoordinates(row.latitude, row.longitude),
    isBookable: row.availability === 'available',

    catalogTags,
    terrainUse: row.terrain_use || null,
    catalogBucket: row.catalog_bucket || null,
    displayInDiscovery: !!row.display_in_discovery,

    badges: [...new Set([
      ...catalogTags,
      row.terrain_use || null,
      row.catalog_bucket || null,
    ].filter(Boolean))],
  };
};

const normalizeJsonArray = (value) => {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (!value) return [];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
    } catch {
      return [];
    }
  }
  return [];
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

  const safePage = Math.max(1, Number(page));
  const safeLimit = Math.max(1, Number(limit));
  const offset = (safePage - 1) * safeLimit;

  const where = `WHERE ${conditions.join(' AND ')}`;

  const countRes = await query(
    `SELECT COUNT(*)::int AS total
     FROM terrains t
     ${where}`,
    params
  );
  const normalizeJsonArray = (value) => {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (!value) return [];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
    } catch {
      return [];
    }
  }
  return [];
};
  const total = countRes.rows[0]?.total || 0;

  params.push(safeLimit, offset);

  const rows = await query(
    `SELECT
       t.id,
       t.ref,
       t.title,
       t.price,
       t.currency,
       t.surface_m2,
       t.location,
       t.latitude,
       t.longitude,
       t.availability,
       t.images,
       t.catalog_tags,
t.terrain_use,
t.catalog_bucket,
t.display_in_discovery,
       z.id AS zone_id,
       z.name AS zone_name,
       z.region AS zone_region
     FROM terrains t
     LEFT JOIN zones z ON z.id = t.zone_id
     ${where}
     ORDER BY t.${sortCol} ${sortOrder}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  const data = rows.rows.map(buildListItem);

  return {
    data,
    meta: {
      total,
      page: safePage,
      limit: safeLimit,
      pages: Math.ceil(total / safeLimit),
    },
  };
};

const getTerrainById = async (terrainId) => {
  const result = await query(
    `SELECT
  t.*,
  t.environment_benefits,
  t.trust_items,
  t.agency_name,
  t.notary_name,
  t.notary_phone,
  t.ninacad,
  t.catalog_tags,
t.terrain_use,
t.catalog_bucket,
t.display_in_discovery,
  z.name AS zone_name,
  z.region AS zone_region
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
  const images = normalizeImages(terrain.images);
  const amenities = normalizeAmenities(terrain.amenities);
  const mainImage = buildMainImage(images);

  const docs = await query(
    `SELECT
       id,
       name,
       original_name,
       type,
       mime_type,
       size_bytes,
       url,
       created_at
     FROM documents
     WHERE related_type = 'terrain'
       AND related_id = $1
       AND (name IS NULL OR name NOT LIKE 'Terrain image - %')
     ORDER BY created_at DESC`,
    [terrainId]
  );

  const documents = docs.rows.map(mapDocument);
  const badges = buildBadges({
    images,
    location: terrain.location,
    docs: docs.rows,
    latitude: terrain.latitude,
    longitude: terrain.longitude,
  });

  const availability = {
    value: terrain.availability,
    label: availabilityLabel(terrain.availability),
  };

  const zone = terrain.zone_id
    ? {
        id: terrain.zone_id,
        name: terrain.zone_name,
        region: terrain.zone_region,
      }
    : null;

  return {
    // Existant conservé
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
    amenities,
    images,
    zone,
    // 🔥 NOUVEAUX CHAMPS POUR MOBILE
environmentBenefits: normalizeJsonArray(terrain.environment_benefits),
trustItems: normalizeJsonArray(terrain.trust_items),
catalogTags: normalizeJsonArray(terrain.catalog_tags),
terrainUse: terrain.terrain_use || null,
catalogBucket: terrain.catalog_bucket || null,
displayInDiscovery: !!terrain.display_in_discovery,

agencyName: terrain.agency_name || null,
notaryName: terrain.notary_name || null,
notaryPhone: terrain.notary_phone || null,
ninacad: terrain.ninacad || null,
    documents,
    reassurance: {
      availabilityLabel: availability.label,
      badges,
      trustPoints: [
  ...normalizeJsonArray(terrain.trust_items),
        'Terrain publié',
        Array.isArray(images) && images.length ? 'Photos disponibles' : null,
        terrain.location ? 'Localisation renseignée' : null,
        documents.length ? 'Documents disponibles' : null,
      ].filter(Boolean),
    },

    // Nouveau format mobile conversion
    slug: terrain.ref ? String(terrain.ref).toLowerCase() : terrain.id,
    reference: terrain.ref,

    hero: {
      title: terrain.title,
      subtitle: terrain.location || terrain.zone_name || '',
      price: {
        amount: terrain.price,
        currency: terrain.currency,
        formatted: formatMoney(terrain.price, terrain.currency),
      },
      surface: {
        value: terrain.surface_m2,
        unit: 'm2',
        formatted: formatSurface(terrain.surface_m2),
      },
      availability,
      badges,
      mainImage,
      gallery: images,
    },

    locationDetails: {
      label: terrain.location || null,
      zone,
      coordinates: {
        latitude: terrain.latitude,
        longitude: terrain.longitude,
      },
      map: {
        enabled: hasCoordinates(terrain.latitude, terrain.longitude),
      },
    },

    descriptionBlock: {
      short: terrain.description || null,
      full: terrain.description || null,
    },

    media: {
      mainImage,
      images,
      documents,
    },

    legal: {
      titleDeed: docs.rows.some((d) => d.type === 'title_deed'),
      surveyPlan: docs.rows.some((d) => d.type === 'survey_plan'),
      contractAvailable: docs.rows.some((d) => d.type === 'contract'),
      highlights: [
        docs.rows.some((d) => d.type === 'title_deed') ? 'Titre foncier disponible' : null,
        docs.rows.some((d) => d.type === 'survey_plan') ? 'Plan cadastral disponible' : null,
        docs.rows.some((d) => d.type === 'contract') ? 'Contrat disponible' : null,
        documents.length ? 'Documents vérifiables' : null,
      ].filter(Boolean),
    },

    payment: {
      cash: {
        enabled: true,
        label: 'Cash',
        benefit: 'Rapidité',
      },
      installment: {
        enabled: true,
        label: 'Échelonné',
        benefit: 'Confort',
        minimumDownPaymentPercent: 30,
        maxDurationMonths: 36,
        note: 'Prix bascule sur 3 ans',
      },
    },

    features: {
      amenities,
      highlights: [
        terrain.location ? 'Localisation renseignée' : null,
        images.length ? 'Photos disponibles' : null,
        hasCoordinates(terrain.latitude, terrain.longitude) ? 'Coordonnées GPS disponibles' : null,
        documents.length ? 'Documents disponibles' : null,
      ].filter(Boolean),
    },

    cta: {
      contactEnabled: true,
      visitEnabled: true,
      requiresAccountForVisit: true,
      primary: {
        type: 'contact',
        label: 'Contacter un conseiller',
      },
      secondary: {
        type: 'visit',
        label: 'Planifier une visite',
      },
    },

    share: {
      enabled: true,
    },
  };
};

const listMapTerrains = async (filters = {}) => {
  const result = await listTerrains({
    ...filters,
    limit: filters.limit || 200,
  });

  return result.data.map((item) => ({
    id: item.id,
    title: item.title,
    price: item.price,
    currency: item.currency,
    formattedPrice: item.formattedPrice,
    surfaceM2: item.surfaceM2,
    formattedSurface: item.formattedSurface,
    location: item.location,
    latitude: item.latitude,
    longitude: item.longitude,
    mainImage: item.mainImage,
    availability: item.availability,
    availabilityLabel: item.availabilityLabel,
    badges: item.badges,
  }));
};

const listPublicZones = async () => {
  const result = await query(
    `SELECT DISTINCT
       z.id,
       z.name,
       z.region
     FROM terrains t
     JOIN zones z ON z.id = t.zone_id
     WHERE t.status = 'published'
     ORDER BY z.name ASC`
  );

  return result.rows;
};

const listPublicFilterOptions = async () => {
  const [zonesRes, locationsRes, rangesRes] = await Promise.all([
    query(
      `SELECT DISTINCT
         z.id,
         z.name,
         z.region
       FROM terrains t
       JOIN zones z ON z.id = t.zone_id
       WHERE t.status = 'published'
       ORDER BY z.name ASC`
    ),
    query(
      `SELECT DISTINCT
         t.location
       FROM terrains t
       WHERE t.status = 'published'
         AND t.location IS NOT NULL
         AND TRIM(t.location) <> ''
       ORDER BY t.location ASC`
    ),
    query(
      `SELECT
         MIN(t.price) AS min_price,
         MAX(t.price) AS max_price,
         MIN(t.surface_m2) AS min_surface,
         MAX(t.surface_m2) AS max_surface
       FROM terrains t
       WHERE t.status = 'published'`
    ),
  ]);

  return {
    zones: zonesRes.rows,
    locations: locationsRes.rows.map((r) => r.location),
    ranges: rangesRes.rows[0] || {
      min_price: null,
      max_price: null,
      min_surface: null,
      max_surface: null,
    },
    sorts: [
      { label: 'Plus récents', value: 'created_at', order: 'desc' },
      { label: 'Prix croissant', value: 'price', order: 'asc' },
      { label: 'Prix décroissant', value: 'price', order: 'desc' },
      { label: 'Surface croissante', value: 'surface_m2', order: 'asc' },
      { label: 'Surface décroissante', value: 'surface_m2', order: 'desc' },
      { label: 'Titre A-Z', value: 'title', order: 'asc' },
    ],
  };
};

module.exports = {
  listTerrains,
  getTerrainById,
  listMapTerrains,
  listPublicZones,
  listPublicFilterOptions,
};