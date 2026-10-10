# Phi Bot

Phi Bot est une équipe d'agents IA que vous installez sur votre propre serveur Linux. Vous lui confiez des tâches ; un agent CEO les organise, les découpe et les fait avancer, avec ses collègues, dans une interface web. Le moteur de chaque agent est [phi](https://github.com/uglyswap/phi-code) : mémoire complète (notes, ontologie, recherche sémantique), navigateur Camoufox, outils de fichiers et de recherche, connecteurs MCP (dont Composio) et skills.

Phi Bot est un fork de [Paperclip](https://github.com/paperclipai/paperclip) (licence MIT, voir `NOTICE.md`). Une installation sert une seule entreprise : la vôtre. Vous utilisez votre propre fournisseur IA, avec votre clé API.

## Ce qu'il faut

- Un serveur Linux **x86_64** avec systemd : Ubuntu 24.04 ou 22.04, ou Debian 12. Les autres architectures (arm64), macOS et Windows ne sont pas pris en charge (sous Windows : WSL2 avec Ubuntu 24.04 et systemd activé).
- Un accès root (`sudo`).
- 2 vCPU, 4 Go de mémoire vive et 20 Go de disque libre au minimum ; 4 vCPU, 8 Go et 40 Go conseillés. Chaque agent qui utilise le navigateur consomme environ 1 Go.
- Node.js 24.11 ou plus récent, installé pour tout le système (pas avec nvm) :

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup.sh
sudo bash /tmp/nodesource_setup.sh
sudo apt-get install -y nodejs
node --version   # v24.11.0 ou plus récent
```

- Une clé API d'un fournisseur IA (voir « Fournisseurs IA »).

## Installer

Une seule commande. Avec un nom de domaine qui pointe déjà vers le serveur (enregistrement DNS A ou AAAA) et les ports 80 et 443 ouverts :

```bash
sudo env PHI_SKIP_POSTINSTALL=1 CAMOUFOX_SKIP_DOWNLOAD=1 ONNXRUNTIME_NODE_INSTALL_CUDA=skip npx --yes @phi-code-admin/phi-bot@latest setup --domain bot.exemple.fr
```

Remplacez `bot.exemple.fr` par votre domaine. Les trois variables évitent de télécharger dans le compte root près de 1 Go de fichiers inutiles (le navigateur et les bibliothèques CUDA) : Phi Bot les prépare ensuite pour son propre compte.

La commande vérifie le serveur, vous demande l'e-mail et le mot de passe du propriétaire (12 caractères minimum) puis le nom de l'entreprise, installe les paquets système nécessaires, crée le compte système `phibot`, installe Phi Bot durablement, prépare le navigateur Camoufox et le modèle de recherche sémantique de la mémoire, installe et démarre le service, crée le propriétaire et l'entreprise, et seulement ensuite ouvre l'accès HTTPS (Caddy, certificat Let's Encrypt). Comptez 10 à 20 minutes. Elle se termine par l'adresse de Phi Bot. En cas d'interruption, relancez la même commande : elle reprend là où elle s'était arrêtée.

### Sans nom de domaine

- **Tunnel SSH** (rien n'est ouvert sur Internet) : remplacez `--domain bot.exemple.fr` par `--access ssh`. Depuis votre poste, ouvrez le tunnel puis l'adresse `http://localhost:3100` :

  ```bash
  ssh -N -L 3100:127.0.0.1:3100 <utilisateur>@<serveur>
  ```

- **Tailscale** : installez Tailscale sur le serveur et connectez-le (`sudo tailscale up`), avec HTTPS activé dans votre tailnet, puis remplacez `--domain bot.exemple.fr` par `--access tailscale`. Phi Bot est alors servi à l'adresse `https://<machine>.<tailnet>.ts.net` affichée à la fin, pour les seuls appareils de votre tailnet.

Pour changer d'accès plus tard : `sudo phibot setup --reconfigure --access domain --domain bot.exemple.fr` (ou `--access ssh`, `--access tailscale`).

### Installation sans questions

Pour un script : `--yes` avec `--owner-email <e-mail>`, `--owner-password-file <fichier>` (fichier lisible par root seul, une ligne) et `--company <nom>`. Le mot de passe n'est jamais passé en argument.

## Installation avec Docker (facultatif)

L'installation recommandée reste `sudo npx --yes @phi-code-admin/phi-bot@latest setup` (section précédente). L'image Docker `ghcr.io/uglyswap/phi-bot` est une autre possibilité, pour les serveurs où tout tourne déjà dans Docker. Elle contient exactement le paquet npm publié, avec phi, le navigateur Camoufox (téléchargé au premier démarrage) et la base de données embarquée.

Prérequis : un serveur Linux x86_64 avec Docker Engine 24 ou plus récent et le plugin Docker Compose, 4 Gio de mémoire vive (8 Gio conseillés), 10 Gio d'espace libre.

### Démarrer

```bash
mkdir -p ~/phibot && cd ~/phibot
curl -fsSLO https://raw.githubusercontent.com/uglyswap/phi-bot/main/phibot/docker/docker-compose.yml
curl -fsSLO https://raw.githubusercontent.com/uglyswap/phi-bot/main/phibot/docker/Caddyfile
docker compose up -d
docker compose ps
```

Le premier démarrage télécharge Camoufox (environ 680 Mio) et le vérifie : comptez quelques minutes. Phi Bot est prêt quand `docker compose ps` affiche `(healthy)` dans la colonne `STATUS` du service `phibot`. Pour suivre le démarrage : `docker compose logs -f phibot` (Ctrl+C pour quitter l'affichage, Phi Bot continue de tourner).

Créez ensuite le propriétaire et l'entreprise (nom, e-mail, mot de passe de 12 caractères minimum, nom de l'entreprise) :

```bash
docker compose exec -it phibot phibot owner create
```

Phi Bot écoute seulement sur `127.0.0.1:3100` du serveur. Depuis votre poste, ouvrez un tunnel SSH puis l'adresse `http://localhost:3100` :

```bash
ssh -N -L 3100:127.0.0.1:3100 <utilisateur>@<serveur>
```

Connectez-vous avec l'e-mail et le mot de passe du propriétaire : l'assistant vous demande alors votre fournisseur IA, votre clé API et votre modèle.

### Accès par un nom de domaine (HTTPS)

Le profil `https` ajoute un proxy Caddy qui obtient le certificat automatiquement. Avant le premier démarrage, faites pointer le domaine (enregistrement DNS A ou AAAA) vers le serveur, ouvrez les ports 80 et 443, puis écrivez le fichier `.env` à côté de `docker-compose.yml` (remplacez `phibot.example.com` par votre domaine) :

```bash
cat > .env <<'EOF'
COMPOSE_PROFILES=https
PHIBOT_DOMAIN=phibot.example.com
PAPERCLIP_PUBLIC_URL=https://phibot.example.com
PAPERCLIP_ALLOWED_HOSTNAMES=phibot.example.com
EOF
docker compose up -d
```

Phi Bot est alors servi sur `https://phibot.example.com`. Si Phi Bot a déjà démarré une première fois sans domaine, créez d'abord le propriétaire (`owner create`), puis ajoutez aussi la ligne `PAPERCLIP_AUTH_BASE_URL_MODE=explicit` au fichier `.env` avant `docker compose up -d`.

### Mettre à jour

```bash
cd ~/phibot
docker compose exec phibot phibot backup --full
docker compose exec phibot rm -f /var/lib/phibot/.paperclip/instances/default/.phibot-setup-complete
docker compose pull
docker compose up -d
docker compose ps
docker compose exec phibot sh -c 'phibot phi:prepare --company "$(ls /var/lib/phibot/.phi/phibot/companies)"'
```

Dans l'ordre : sauvegarde complète, demande de nouvelle préparation de Camoufox au prochain démarrage (utile si la nouvelle version de phi en change), téléchargement de la nouvelle image, redémarrage (les migrations de la base s'appliquent seules), contrôle de l'état (attendre `(healthy)`), puis préparation de phi pour votre entreprise avec la nouvelle version. Pour rester sur une version précise, ajoutez `PHIBOT_VERSION=<version>` au fichier `.env` (par défaut : `latest`).

### Sauvegarder

```bash
cd ~/phibot
docker compose exec phibot phibot backup --full
docker compose exec phibot ls -1 /var/lib/phibot/.paperclip/instances/default/data/backups/
docker compose cp phibot:/var/lib/phibot/.paperclip/instances/default/data/backups/<archive full-....tar.gz> ./
docker compose cp phibot:/var/lib/phibot/.paperclip/instances/default/secrets/master.key ./master.key
```

L'archive contient la base, la configuration, les secrets, les fichiers joints, les dossiers de travail des agents et la mémoire de phi. Copiez-la, avec `master.key`, hors du serveur : sans cette clé, la clé de votre fournisseur IA et les autres secrets enregistrés sont perdus. Les sauvegardes horaires de la base continuent dans le volume Docker `phibot_phibot-data`.

### Restaurer

Une archive produite par l'image Docker se restaure dans Docker (une archive d'une installation sans Docker se restaure avec `sudo phibot setup --restore <archive>` sur un serveur). Sur un serveur neuf, faites d'abord « Démarrer » jusqu'à `(healthy)`, sans créer de propriétaire. Puis, dans `~/phibot`, avec l'archive à côté de `docker-compose.yml` :

```bash
cd ~/phibot
sudo chown 10001:10001 full-<horodatage>.tar.gz
sudo chmod 600 full-<horodatage>.tar.gz
docker compose stop phibot
docker compose run --rm --no-deps -v "$PWD/full-<horodatage>.tar.gz:/restore/archive.tar.gz:ro" phibot phibot db:restore /restore/archive.tar.gz --yes
docker compose up -d
docker compose ps
```

Le propriétaire se connecte ensuite avec son ancien mot de passe.

### Arrêter ou désinstaller

`docker compose stop` arrête Phi Bot, `docker compose up -d` le relance. `docker compose down` supprime les conteneurs et garde les données (volume `phibot_phibot-data`). `docker compose down -v` supprime **aussi toutes les données** : faites d'abord une sauvegarde.

## Premier lancement

Ouvrez l'adresse affichée et connectez-vous avec l'e-mail et le mot de passe du propriétaire. L'assistant de Phi Bot vous demande seulement :

1. votre fournisseur IA et votre clé API ;
2. votre modèle par défaut.

Il teste la connexion, crée votre premier agent (le CEO) et ouvre sa première tâche : écrivez-lui ce que vous attendez. Vous pouvez inviter les membres de votre équipe depuis les réglages de l'entreprise ; l'inscription n'est possible qu'avec une invitation.

## Fournisseurs IA

Réglages > « Fournisseur IA » permet de changer de fournisseur, de clé ou de modèle à tout moment. La clé est stockée chiffrée dans Phi Bot et n'est jamais écrite en clair sur le disque.

| Fournisseur | Remarque |
|---|---|
| Anthropic (Claude) | clé API Anthropic (pas d'abonnement Claude) |
| OpenAI | clé API OpenAI (pas d'abonnement ChatGPT) |
| Google Gemini | |
| OpenRouter | |
| xAI (Grok) | |
| DeepSeek | |
| Mistral | |
| Groq | |
| Z.ai (GLM) | |
| Moonshot (Kimi) | |
| MiniMax | |
| OpenCode Go | |
| Alibaba Coding Plan | |
| Compatible OpenAI (URL personnalisée) | tout service qui expose l'API OpenAI : indiquez son URL de base |
| Compatible Anthropic (URL personnalisée) | tout service qui expose l'API Anthropic : indiquez son URL de base |

Phi Bot n'utilise que des clés API : la connexion par compte (OAuth) d'un abonnement n'est pas prise en charge.

## Commandes d'exploitation

Toutes se lancent sur le serveur, avec `sudo`.

| Commande | Effet |
|---|---|
| `sudo phibot service status` | état du service ; `sudo phibot service restart` le redémarre, `sudo phibot service logs` affiche son journal |
| `sudo phibot doctor` | contrôle complet (service, base, navigateur, mémoire, sauvegardes, disque, fournisseur IA) avec la correction de chaque problème ; `--repair` répare |
| `sudo phibot update` | met à jour vers la dernière version (ou `--version <v>`), avec sauvegarde préalable et retour automatique à la version précédente en cas d'échec |
| `sudo phibot backup --full` | archive complète (base, configuration, secrets, fichiers, mémoire des agents) dans `/var/lib/phibot/.paperclip/instances/default/data/backups/` ; `--output <chemin>` pour la placer ailleurs. Copiez-la hors du serveur |
| `sudo phibot db:restore <fichier>` | restaure une sauvegarde de la base (`*.sql.gz`) ou une archive de `backup --full` |
| `sudo phibot setup --restore <archive>` | réinstalle Phi Bot sur un serveur neuf à partir d'une archive de `backup --full` (avec `--domain`, `--access`) ; le propriétaire garde son mot de passe |
| `sudo phibot setup --reconfigure --access <domain\|ssh\|tailscale>` | change le mode d'accès |
| `sudo phibot user reset-password --email <e-mail>` | donne un nouveau mot de passe aléatoire à un compte (Phi Bot n'envoie pas d'e-mails) |
| `sudo phibot uninstall` | arrête et retire le service ; garde les données, sauf `--purge` (confirmation demandée) ; affiche ensuite la commande `npm uninstall -g @phi-code-admin/phi-bot` |

Les sauvegardes horaires de la base sont automatiques (rétention réglable dans Instance > Général).

## Sécurité et limites

- Phi Bot écoute seulement sur la boucle locale du serveur (`127.0.0.1:3100`) ; seul Caddy (accès par domaine) est exposé, sur les ports 80 et 443. La base de données embarquée écoute sur `127.0.0.1:54329` et une règle `nftables` (service `phibot-guard`) en refuse l'accès aux autres comptes du serveur. Un serveur dédié à Phi Bot reste conseillé.
- Le propriétaire est créé par l'installation, avant toute ouverture de l'accès. L'inscription demande une invitation. Il n'y a ni télémétrie ni appel vers Paperclip.
- Les agents tournent sous le compte système `phibot`, sans droits root, avec un durcissement systemd (pas d'accès à `/home` ni `/root`, `/usr` et `/etc` en lecture seule, `/tmp` privé).
- **Limite assumée de cette version** : les agents et le serveur partagent le compte `phibot`. Un agent manipulé (page web, document ou e-mail piégé) peut donc lire les secrets de Phi Bot (clé de chiffrement, base, clé de votre fournisseur IA) et prendre le contrôle de l'instance. N'invitez que des personnes de confiance et ne confiez pas aux agents de données plus sensibles que l'instance elle-même. La séparation des comptes de l'agent et du serveur est prévue pour une version ultérieure.
- Le paquet npm est publié depuis la CI du dépôt avec une attestation de provenance, et contient un `npm-shrinkwrap.json` : l'arbre de dépendances installé chez vous est exactement celui qui a été testé.

## Licence

MIT. Phi Bot est un fork de Paperclip ; le fichier `LICENSE` et la mention de copyright d'origine sont conservés, voir `NOTICE.md`. Le README d'origine de Paperclip est conservé dans `README.paperclip.md`.
