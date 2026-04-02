# Ikadou Backend API

API REST Node.js / Express pour le projet Ikadou — vente sécurisée de terrains au Mali.

## Stack

- **Runtime** — Node.js 18+
- **Framework** — Express 4
- **Base de données** — PostgreSQL 15+
- **Auth** — JWT (access token 7j + refresh token 30j)
- **Logs** — Winston

## Installation

```bash
npm install

```

## Base de données

```bash



# 2. Appliquer le schéma
npm run db:migrate

# 3. Injecter les données initiales (admin + zones + templates)
npm run db:seed
```


## Démarrage

```bash
# Développement (nodemon)
npm run dev

# Production
npm start
```

L'API démarre sur `http://localhost:5000`



## Architecture

```
src/
├── config/        ← Variables d'environnement
├── data/          ← Pool PostgreSQL + helpers
├── db/            ← Schéma SQL, migrations, seed
├── middleware/    ← Auth, rate limiter, error handler
├── routes/        ← Endpoints REST (1 fichier par module)
├── services/      ← Logique métier (Phase 2+)
├── utils/         ← Logger, HttpError, auth helpers
├── app.js         ← Express app
└── server.js      ← Point d'entrée
```

## Rôles disponibles

| Rôle        | Niveau | Description |
|-------------|--------|-------------|
| super_admin | 7      | Accès total |
| admin       | 6      | Administration |
| manager     | 5      | Pilotage opérationnel |
| finance     | 4      | Module financier |
| sales       | 3      | CRM commercial |
| support     | 3      | Tickets support |
| agent       | 2      | Terrain |
# ikadou_backend
