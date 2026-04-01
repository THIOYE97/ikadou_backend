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
cp .env.example .env
# Editer .env avec vos paramètres PostgreSQL
```

## Base de données

```bash
# 1. Créer la DB
createdb ikadou_db

# 2. Appliquer le schéma
npm run db:migrate

# 3. Injecter les données initiales (admin + zones + templates)
npm run db:seed
```

**Identifiants par défaut** (à changer immédiatement) :
- Email : `admin@ikadou.com`
- Mot de passe : `Ikadou@2025!`

## Démarrage

```bash
# Développement (nodemon)
npm run dev

# Production
npm start
```

L'API démarre sur `http://localhost:5000`

## Endpoints Phase 1

| Méthode | Route                      | Description                  | Auth |
|---------|----------------------------|------------------------------|------|
| POST    | `/api/v1/auth/login`       | Connexion                    | ❌   |
| POST    | `/api/v1/auth/refresh`     | Rafraîchir le token          | ❌   |
| POST    | `/api/v1/auth/logout`      | Déconnexion                  | ✅   |
| GET     | `/api/v1/auth/me`          | Profil courant               | ✅   |
| POST    | `/api/v1/auth/change-password` | Changer le mot de passe  | ✅   |
| GET     | `/api/v1/users`            | Liste utilisateurs internes  | ✅ manager+ |
| POST    | `/api/v1/users`            | Créer un utilisateur interne | ✅ admin+ |
| GET     | `/api/v1/users/:id`        | Fiche utilisateur            | ✅ manager+ |
| PATCH   | `/api/v1/users/:id`        | Modifier un utilisateur      | ✅ admin+ |
| GET     | `/health`                  | Health check                 | ❌   |

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
