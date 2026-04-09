# GEII ESA 2026 - Launcher Simulateur d'Avion

Application Electron + React pour préparer et exécuter rapidement les modules du simulateur d'avion du projet GEII ESA 2026.

## Modules gérés

- Navigation Display
- Primary Flight Display
- Warning Panel

Repos utilisés:

- https://github.com/CamilGrondin/Navigation-Display
- https://github.com/CamilGrondin/Primary-Flight-Display
- https://github.com/CamilGrondin/Warning-Panel

## Fonctions du launcher

- Création automatique du dossier racine de travail
- Pull / clone des dépôts
- Installation des dépendances (npm, yarn, pnpm, bun, uv, poetry, pipenv, pip requirements)
- Lancement et arrêt de chaque module
- Lancement/arrêt global
- Journal d'exécution en temps réel

## Prérequis

- Node.js 20+
- npm
- git
- python3 (si un des modules est en Python)

Optionnels selon les projets:

- bun
- uv
- poetry
- pipenv

## Installation

```bash
npm install
```

## Lancement en développement

```bash
npm run dev
```

Cette commande démarre:

- le front React (Vite)
- Electron, connecté au front

## Lancement en mode application

1. Générer le front:

```bash
npm run build
```

2. Démarrer Electron:

```bash
npm start
```

## Structure du projet

- electron/main.cjs: fenêtre Electron et handlers IPC
- electron/preload.cjs: API exposée au front
- electron/launcherService.cjs: logique clone/pull/install/start/stop
- src/App.jsx: interface launcher
- src/App.css: styles du dashboard

## Note

Les commandes de lancement sont détectées automatiquement (scripts start/dev/launch/serve, ou fichiers Python classiques). Si un repo utilise une commande spécifique non standard, ajoutez un script start ou dev dans son package.json pour une intégration optimale.
