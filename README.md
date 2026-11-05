# Offres produits — Amazon.fr & AliExpress

Application web locale permettant de :

- Rechercher les meilleures offres à partir d'une description produit (ex. "mini PC de 16Go de ram minimum avec un processeur ryzen").
- Comparer les résultats d'Amazon.fr et AliExpress.
- Suivre un produit et être alerté lorsqu'une bonne offre est détectée (baisse de prix, prix sous une cible, nouveau minimum).

## Installation

```bash
cd ~/product-deals
npm install
```

Chromium doit être installé (`/usr/bin/chromium`). Playwright utilise le Chromium système.

## Lancement

```bash
npm start
```

Puis ouvrir http://localhost:3000

## Fonctionnement

- Backend Node.js + Playwright (scraping) + SQLite (historique des prix).
- Vérification automatique des prix suivis toutes les 30 minutes.
- Bouton "Vérifier tous les prix" pour forcer une mise à jour.
- Notifications navigateur activables via le bouton dédié.

## Notes

- Le scraping dépend des sites cibles et peut nécessiter des ajustements si leur structure change.
- Amazon/AliExpress peuvent afficher des challenges anti-bot ; l'application utilise un navigateur avec des réglages "stealth" pour limiter ce problème.