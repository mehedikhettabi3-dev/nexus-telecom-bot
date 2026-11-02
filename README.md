# NEXUS-TELECOM — Production Deployment & Quickstart Guide

## 1. Description du Projet
Application autonome Node.js pour la détection de couverture Fibre Optique au Maroc (Maroc Telecom, Inwi, Orange) et la qualification automatique de prospects via WhatsApp (Baileys + Turf.js + MongoDB + Render Persistent Disk).

---

## 2. Structure des Fichiers
- `server.js` : Serveur Express, client Baileys WebSocket, moteur spatial Turf.js avec 15m buffer et 90% smart proximity fallback, gestionnaire de conversation en Darija et double notification.
- `package.json` : Dépendances exactes requises.
- `zones.geojson` : Polygones de couverture FTTH / Fibre.
- `.env.example` : Modèle de variables d'environnement avec toutes vos clés et identifiants.
- `render.yaml` : Configuration Render avec disque persistant de 1 Go monté sur `/var/data` pour ne jamais perdre la session WhatsApp.

---

## 3. Test & Lancement en Local (Windows/Mac/Linux)

1. Ouvrez un terminal dans ce dossier :
   ```bash
   npm install
   ```

2. Créez votre fichier `.env` à partir de `.env.example` :
   ```bash
   cp .env.example .env
   ```
   Remplissez votre mot de passe MongoDB Atlas dans `MONGODB_URI`.

3. Démarrez le bot :
   ```bash
   npm start
   ```

4. Scannez le QR Code qui apparaît dans le terminal avec votre téléphone WhatsApp Business. Une fois connecté, le dossier `auth_info_baileys` enregistre la session et vous n'aurez plus jamais besoin de scanner !

---

## 4. Déploiement sur Render (24h/24 sans interruption)

1. Poussez ce code sur un dépôt GitHub (privé de préférence).
2. Sur votre compte Render :
   - Cliquez sur **New +** -> **Blueprint**.
   - Connectez votre dépôt GitHub. Render lira automatiquement `render.yaml`.
   - Render va provisionner un **Web Service** avec un **Persistent Disk (1GB)** monté sur `/var/data`.
3. Ajoutez vos variables dans Render Dashboard (**Environment**) :
   - `MONGODB_URI`
   - `ADMIN_PHONE` (212625489153)
   - `WASIT_PHONE` (Numéro de votre technicien/intermédiaire)
4. Dans l'onglet **Logs** de Render, le QR Code s'affichera lors du premier lancement. Scannez-le une seule fois depuis votre téléphone.
5. Grâce au Persistent Disk `/var/data/auth_info_baileys`, le bot restera connecté en permanence même en cas de restart du serveur Render.
