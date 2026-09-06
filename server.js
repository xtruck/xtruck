/**
 * ============================================================================
 * server.js — Pipeline audio → transcription cloud → détection de référence
 * biblique → overlay en temps réel (WebSocket)
 * ----------------------------------------------------------------------------
 * v1.1.0 — SECURITY HARDENED:
 *   + Role-based access control (operator vs viewer)
 *   + Origin validation for non-localhost binds
 *   + Per-message-type rate limiting
 *   + Prompt injection filtering for all LLM-bound text
 *   + WS_AUTH_TOKEN minimum length enforcement (16 chars)
 *   + File permissions on temp audio files (0o600)
 * ============================================================================
 */

'use strict';

const { parentPort, workerData } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ---------------------------------------------------------------------------
// Environment & paths
// ---------------------------------------------------------------------------
const APP_ROOT = (workerData && workerData.appRoot) || __dirname;
// CORRECTIF (e2e — pollution du dossier utilisateur réel) : hors du worker
// Electron (workerData absent), ce chemin retombait sur le VRAI
// ~/.churchoverlay de la machine — celui d'un opérateur réel. test/e2e/
// start-server.js lance ce fichier directement via `node` (pas de worker),
// donc chaque suite e2e écrivait ses scènes/médias factices dans ce
// dossier réel au lieu d'un dossier de test isolé. CHURCHOVERLAY_DATA_DIR
// (déjà le nom utilisé par bin/church-agent.js pour le même besoin) permet
// à start-server.js de pointer vers un dossier temporaire dédié.
const USER_DATA_DIR =
  (workerData && workerData.userDataDir) ||
  process.env.CHURCHOVERLAY_DATA_DIR ||
  path.join(os.homedir(), '.churchoverlay');
// AJOUT (Chantier 2 — health system) : version de l'app affichée par
// /api/health et /api/status (diagnostic). Chargée une seule fois au boot,
// jamais relue.
const APP_VERSION = require(path.join(APP_ROOT, 'package.json')).version;

// ---------------------------------------------------------------------------
// Core modules (REQUIRED)
// ---------------------------------------------------------------------------
const actionRegistry = require('./action-registry');
const audioCapture = require('./audio-capture');
const groq = require('./groq-wrapper');
const deepgramWrapper = require('./deepgram-wrapper');
const asrEngine = require('./asr-engine');
const configValidator = require('./config-validator');
const { createFileLogger } = require('./logger');
const sessionStore = require('./session-store');

const detector = require('./detector-compat');
const bibleLookup = require('./bible-lookup-with-api');
// AJOUT (cahier des charges — base biblique hors-ligne) : voir bible-offline-cache.js.
const bibleOfflineCache = require('./bible-offline-cache');
const { ReadingMode } = require('./reading-mode');
const themeLoader = require('./theme-loader');
// AJOUT (audit — mémoire des cultes, gratuit/léger) : même discipline que
// bible-semantic-search.js — fichier JSON local, recherche par mots-clés,
// aucun modèle d'embedding, aucun appel API. Voir sermon-archive.js.
const sermonArchive = require('./sermon-archive');
// AJOUT (cahier des charges — assistant sermons) : voir sermon-qa.js.
const sermonQa = require('./sermon-qa');
// AJOUT (médiathèque — déclenchement vocal de photos/vidéos) : même
// discipline que sermon-archive.js ci-dessus. Voir media-library.js.
const mediaLibrary = require('./media-library');
// AJOUT (studio de scènes — texte/logo/image composés, déclenchables comme
// un poster) : voir scene-store.js. Une scène référence des éléments de
// media-library.js par id, ne possède aucun fichier propre.
const sceneStore = require('./scene-store');
// AJOUT (Partie 7.1.1 — import PowerPoint, portée réduite au texte des
// diapositives) : voir pptx-importer.js pour le pourquoi de cette portée.
const pptxImporter = require('./pptx-importer');
// AJOUT (modularisation backend — perf) : voir task-queue.js. Sort l'import
// PowerPoint (lecture disque + parsing XML) du chemin WS synchrone —
// concurrence 1 par défaut, largement suffisant (import PPTX = action rare,
// jamais deux à la fois en pratique).
const { createTaskQueue } = require('./task-queue');
// AJOUT (Partie 7.1.2 — service portable, export uniquement, voir
// service-export.js pour le pourquoi de cette portée).
const serviceExport = require('./service-export');
// AJOUT (Partie 7.1.2 — service portable, IMPORT, voir service-import.js en
// tête pour la protection zip slip et la logique de remappage d'id).
const serviceImport = require('./service-import');
// AJOUT (chantier 4.3 — sortie broadcast, feuille de route/cue-list) : une
// séquence PRÉ-PLANIFIÉE de repères verset/média/scène que l'opérateur
// construit à l'avance et déclenche dans l'ordre — voir rundown-store.js.
const rundownStore = require('./rundown-store');
// AJOUT (caméras de téléphone — demande explicite) : liste de flux MJPEG
// réseau (apps type "IP Webcam"), distincte de camera-capture.js (webcams
// locales via navigator.mediaDevices) — voir ip-camera-store.js.
const ipCameraStore = require('./ip-camera-store');
// AJOUT (habillage caméra — logo/titre, demande explicite) : voir
// branding-store.js (logo persisté) et branding-overlay.html (page
// affichée par-dessus la caméra dans OBS).
const brandingStore = require('./branding-store');
// AJOUT (identité de marque du tableau de bord — revente en produit "clé en
// main", une installation par client) : nom d'organisation/couleur
// d'accent/logo affichés dans la barre latérale du tableau de bord
// lui-même — voir l'en-tête de dashboard-branding-store.js pour la
// distinction avec brandingStore ci-dessus (habillage caméra) et
// theme-loader.js (thème de l'overlay de projection).
const dashboardBrandingStore = require('./dashboard-branding-store');
// AJOUT (caméra téléphone par QR code, demande explicite) : voir
// phone-camera-pairing.js (codes/secrets), phone-camera.html (page ouverte
// par le téléphone) et les routes HTTP /phone-camera-* plus bas.
const phoneCameraPairing = require('./phone-camera-pairing');
const QRCode = require('qrcode');
// AJOUT (sous-titres traduits en direct) : module isolé, jamais attendu
// avant processTranscript() — voir startPipeline() et caption-translator.js.
const captionTranslator = require('./caption-translator');
// AJOUT (export des temps forts d'un culte) : module pur, aucune donnée
// nouvelle collectée — voir highlight-export.js.
const highlightExport = require('./highlight-export');
// AJOUT (chantier 4.6 — extraits vidéo) : voir clip-exporter.js. require()
// tardif volontairement évité ici (contrairement à obs-controller.js par
// ex.) — clip-exporter.js ne fait rien au chargement (pas de connexion
// réseau/fichier ouverte), donc aucun coût de démarrage à éviter.
const clipExporter = require('./clip-exporter');
// Zéro-point utilisé pour les temps forts exportés (voir action
// 'exportHighlights' plus bas) : approximation raisonnable du début du
// culte (démarrage du process serveur), pas une vérité absolue — un
// enregistrement OBS démarré séparément peut différer de quelques secondes,
// ajustables manuellement par l'opérateur au besoin.
const SESSION_STARTED_AT = Date.now();
// AJOUT (bibliothèque de chants — déclenchement vocal, section suivante/
// précédente en direct) : même discipline que media-library.js ci-dessus.
// Voir song-library.js.
const songLibrary = require('./song-library');
const voiceTriggerMatcher = require('./voice-trigger-matcher');
const featuresStore = require('./features-store');
const validation = require('./validation');
const { createChurchOverlayAgent } = require('./ai-agent');

let churchAgent = null;

function closeChurchAgent() {
  if (!churchAgent) return;
  try {
    churchAgent.close();
  } catch (err) {
    warn('Agent IA : fermeture de la mémoire impossible : ' + err.message);
  }
  churchAgent = null;
}

// ---------------------------------------------------------------------------
// AJOUT (chantier 4.4 — accessibilité, sous-titres traduits sur companion.html)
// ---------------------------------------------------------------------------
// caption-translator.js produit déjà des traductions en direct, diffusées
// aux clients WebSocket (action 'transcriptTranslation', voir startPipeline
// ci-dessous) — mais companion.html (page QR "second écran" pour
// l'assemblée) suit délibérément une discipline différente : polling HTTP
// simple, aucun WebSocket, aucun jeton (voir le commentaire au-dessus de
// /api/verses). Ce petit état en mémoire, mis à jour aux deux mêmes
// endroits qui diffusent déjà 'transcript'/'transcriptTranslation', permet
// à /api/captions (plus bas) d'exposer le DERNIER sous-titre (et sa
// traduction, si activée) sans dupliquer la logique de traduction
// elle-même ni ajouter de canal WS à une page pensée pour rester la plus
// simple possible.
let lastLiveCaption = { text: null, translation: null, timestamp: null };
function updateLiveCaption(text, translation) {
  lastLiveCaption = { text: text || null, translation: translation || null, timestamp: Date.now() };
}

// AJOUT (chantier 4.6 — extraits vidéo) : garde simple contre deux exports
// concurrents qui écriraient dans le même dossier de destination en même
// temps (fichiers de sortie potentiellement corrompus par deux process
// ffmpeg écrivant sur le même chemin) — un seul export à la fois, quel que
// soit le nombre de tableaux de bord connectés.
let clipExportInProgress = false;

// AJOUT (chantier 4.3 — feuille de route/cue-list) : quel repère a été
// déclenché en dernier (par triggerRundownCue OU nextRundownCue), pour que
// nextRundownCue() sache par lequel continuer. Volontairement NON persisté
// (comme lastLiveCaption/clipExportInProgress ci-dessus) — un redémarrage du
// serveur reprend la feuille de route depuis son début, ce qui reste sûr
// (jamais de repère sauté par erreur de reprise).
let currentRundownIndex = -1;

// AJOUT (Timeline-Based Service Flow — brief produit, priorité #5) : horaire
// RÉEL de départ de chaque repère effectivement déclenché pendant CE culte
// (cueId -> epoch ms), permettant de comparer "temps réellement écoulé"
// contre "durée estimée cumulée" (voir rundown-ws-handlers.js). Volontairement
// NON réinitialisé par addRundownCue/removeRundownCue/reorderRundownCues
// (contrairement à currentRundownIndex ci-dessus) : ajouter un repère de plus
// en cours de culte ne doit pas faire oublier l'heure de départ déjà connue —
// seul clearRundown ("nouveau culte, on repart de zéro", voir son commentaire)
// réinitialise l'historique. Volontairement NON persisté, même raisonnement
// que currentRundownIndex : un redémarrage serveur reprend sans historique de
// retard plutôt que de risquer un calcul basé sur un horaire obsolète.
let cueTimeline = new Map();

// ---------------------------------------------------------------------------
// Mode confiance (Partie 2) — verset détecté automatiquement en attente de
// confirmation opérateur ('semi-auto'/'manual', voir session-state.js
// getTrustMode). `finalize` est la MÊME fonction qui afficherait le verset
// immédiatement en mode 'auto' — capturée en closure par processTranscript/
// displayChapterFallback, jamais dupliquée. Une seule référence en attente à
// la fois : une nouvelle détection REMPLACE la précédente (jamais empilée),
// même sémantique que candidateVerse (voir showCandidateVerse côté
// dashboard) — un opérateur qui n'a pas encore confirmé une candidate
// dépassée par une nouvelle intention n'a pas à gérer une file d'attente.
let pendingVerse = null; // { reference, finalize, createdAt } | null

function setPendingVerse(reference, finalize) {
  pendingVerse = { reference, finalize, createdAt: Date.now() };
}

async function confirmPendingVerse() {
  if (!pendingVerse) return { ok: false, reason: 'Aucun verset en attente de confirmation.' };
  const { finalize, reference } = pendingVerse;
  pendingVerse = null;
  await finalize();
  return { ok: true, reference };
}

function dismissPendingVerse() {
  if (!pendingVerse) return { ok: false };
  const reference = pendingVerse.reference;
  pendingVerse = null;
  return { ok: true, reference };
}

// ---------------------------------------------------------------------------
// Durée d'affichage des versets — source unique de vérité
// ---------------------------------------------------------------------------
const DEFAULT_VERSE_DURATION_MS = 120_000;
function getVerseDurationMs() {
  const features = featuresStore.readFeatures();
  return (features.display || {}).verseDurationMs || DEFAULT_VERSE_DURATION_MS;
}

// ---------------------------------------------------------------------------
// Seuil de rejet des transcriptions peu fiables
// ---------------------------------------------------------------------------
// Retours d'usage réel : sur un segment de silence/bruit de sono que Whisper
// n'a pas classé "non-parole" (no_speech_prob pas assez élevé pour
// isSilence, voir computeGroqSpeechInfo dans groq-wrapper.js), le texte
// halluciné passait tel quel jusqu'à la détection de verset — versets
// affichés sans qu'aucune référence n'ait été prononcée. Seuil bas (0.15, très en
// dessous du 0.7+ d'une phrase claire, voir test-groq-speech-info.js) : ne
// filtre que ce qui est déjà quasi-certainement du bruit, pas une parole
// réelle mais incertaine (nom propre rare, accent, micro lointain).
// Réglable en direct via config/features.json (audio.transcriptionConfidenceThreshold,
// rechargé à chaque segment, aucun redémarrage requis) ou, pour compat avec
// les déploiements existants, via la variable d'env TRANSCRIPTION_CONFIDENCE_THRESHOLD
// (utilisée seulement si features.json ne définit rien). Valeur 0 ou négative
// désactive le rejet.
const DEFAULT_TRANSCRIPTION_CONFIDENCE_THRESHOLD = 0.15;
function getTranscriptionConfidenceThreshold() {
  const features = featuresStore.readFeatures();
  const fromFeatures = (features.audio || {}).transcriptionConfidenceThreshold;
  if (typeof fromFeatures === 'number' && Number.isFinite(fromFeatures)) {
    return fromFeatures > 0 ? fromFeatures : null;
  }
  const fromEnv = Number(process.env.TRANSCRIPTION_CONFIDENCE_THRESHOLD);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  if (process.env.TRANSCRIPTION_CONFIDENCE_THRESHOLD === '0') return null;
  return DEFAULT_TRANSCRIPTION_CONFIDENCE_THRESHOLD;
}

// ---------------------------------------------------------------------------
// AI modules (OPTIONAL — wrapped in try-catch, see ai-modules-loader.js)
// ---------------------------------------------------------------------------
const { loadAIModules } = require('./ai-modules-loader');
const {
  semanticDetector,
  detectCommand,
  corrector,
  semanticSearch,
  plugins,
  themeGenerator,
  aiEnricher,
  aiLoadErrors,
  groqHasChatCompletion,
} = loadAIModules({ groq, appRoot: APP_ROOT });

// CORRECTIF (A.2 — visibilité des échecs IA) : `aiLoadErrors` ci-dessus ne
// couvre que les échecs de CHARGEMENT (au démarrage) — un échec d'APPEL
// (ex. Groq indisponible en pleine prédication alors que le module a bien
// chargé) restait invisible, seulement loggé en console (voir
// transcription-corrector.js/semantic-detector.js/ai-theme-generator.js,
// tous trois câblés ici sur `.onError`). `broadcast` est une function
// déclaration (hoisted, définie plus bas dans ce fichier) — sûr à
// référencer ici, elle ne sera appelée qu'au runtime, bien après.
function wireAiModuleErrorBroadcast(mod, moduleName) {
  if (!mod) return;
  mod.onError = (message) => {
    broadcast({ action: 'aiModuleError', module: moduleName, message, at: Date.now() });
  };
}
wireAiModuleErrorBroadcast(corrector, 'corrector');
wireAiModuleErrorBroadcast(semanticDetector, 'semanticDetector');
wireAiModuleErrorBroadcast(themeGenerator, 'themeGenerator');

// ---------------------------------------------------------------------------
// HTTP & WebSocket server
// ---------------------------------------------------------------------------
const express = require('express');
const compression = require('compression');
const http = require('http');
const WebSocket = require('ws');
const { createRateLimiter } = require('./rate-limiter');

const portValidation = configValidator.validateEnvVar('PORT', process.env.PORT);
if (!portValidation.valid) {
  console.warn(`[server] ${portValidation.error} — utilisation du port par défaut 8765.`);
}
const SERVER_PORT = portValidation.valid ? portValidation.parsedValue : 8765;

const hostValidation = configValidator.validateEnvVar('WS_HOST', process.env.WS_HOST);
let WS_HOST = hostValidation.valid ? hostValidation.parsedValue : '127.0.0.1';

// CORRECTIF (audit — bug réel trouvé par `npm run lint`, no-undef) :
// generateCameraPairing (voir plus bas) appelait getLanIpAddress() sans
// qu'elle soit jamais définie dans ce fichier — ReferenceError garanti dès
// qu'un opérateur génère un QR de jumelage caméra téléphone avec WS_HOST
// correctement configuré pour le réseau (exactement le cas d'usage de
// cette fonctionnalité). main.js a sa PROPRE copie de cette même fonction
// (voir son commentaire "même logique que getLanIpAddress() dans
// server.js, dupliquée plutôt que partagée" — qui supposait donc déjà
// l'existence de celle-ci) ; reproduite ici à l'identique.
function getLanIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

// SECURITY: enforce minimum token length of 16 characters.
// Two independent tokens: WS_AUTH_TOKEN (operator, full control) and
// WS_VIEWER_TOKEN (read-only overlay display). A client's role is now
// determined by WHICH token it presents, not by which URL path it hits —
// the path was previously just a client hint and gave no real isolation.
function loadToken(envVar) {
  let token = (process.env[envVar] || '').trim() || null;
  if (token && token.length < 16) {
    console.error(`[server] ${envVar} too short (minimum 16 characters). Ignored.`);
    token = null;
  }
  return token;
}
const WS_AUTH_TOKEN = loadToken('WS_AUTH_TOKEN');
let WS_VIEWER_TOKEN = loadToken('WS_VIEWER_TOKEN');
if (WS_VIEWER_TOKEN && WS_AUTH_TOKEN && WS_VIEWER_TOKEN === WS_AUTH_TOKEN) {
  console.error('[server] WS_VIEWER_TOKEN must differ from WS_AUTH_TOKEN. Viewer token disabled.');
  WS_VIEWER_TOKEN = null;
}
// Once an operator token is configured, requiring a distinct viewer token
// stops a leaked/shared display-page token from granting operator control.
if (WS_AUTH_TOKEN && !WS_VIEWER_TOKEN && WS_HOST !== '127.0.0.1' && WS_HOST !== 'localhost') {
  console.warn(
    '[server] WS_AUTH_TOKEN is set without WS_VIEWER_TOKEN on a non-local bind — ' +
      'the overlay page will need the operator token to connect, which over-privileges it.'
  );
}

// SECURITY (fail-safe, not just advisory): a non-local WS_HOST with no
// operator token would previously start up "open" — any device on the LAN
// could connect with full operator control (broadcast arbitrary verses,
// clear the display mid-service, hit AI/OBS actions) with zero credential.
// Refuse to bind non-locally without a token instead of just warning.
if (WS_HOST !== '127.0.0.1' && WS_HOST !== 'localhost' && !WS_AUTH_TOKEN) {
  console.error(
    `[server] WS_HOST=${WS_HOST} was requested but WS_AUTH_TOKEN is not set (or is too short). ` +
      'Refusing to expose the WebSocket server without authentication — falling back to ' +
      '127.0.0.1. Set WS_AUTH_TOKEN (>=16 chars) to allow LAN/remote access.'
  );
  WS_HOST = '127.0.0.1';
}

// Active par défaut (recommandé) ; VALIDATE_MESSAGES=false ou 0 désactive
// le contrôle strict de validation.js pour les actions qu'il couvre.
const VALIDATE_MESSAGES_ENABLED = !['false', '0'].includes(
  (process.env.VALIDATE_MESSAGES || '').trim().toLowerCase()
);

const maxConnValidation = configValidator.validateEnvVar(
  'MAX_CONNECTIONS',
  process.env.MAX_CONNECTIONS
);
const MAX_CONNECTIONS = maxConnValidation.valid ? maxConnValidation.parsedValue : 10;

const maxMsgValidation = configValidator.validateEnvVar(
  'MAX_MESSAGES_PER_MINUTE',
  process.env.MAX_MESSAGES_PER_MINUTE
);
const MAX_MESSAGES_PER_MINUTE = maxMsgValidation.valid ? maxMsgValidation.parsedValue : 60;

// CORRECTIF (problème récurrent — transcription qui ne démarre jamais
// malgré des clés API valides) : voir config-validator.js pour le détail.
// Réglable via .env sans toucher au code, pour s'adapter au micro réel du
// lieu de culte plutôt que de garder une valeur jamais calibrée.
const micThresholdValidation = configValidator.validateEnvVar(
  'MIC_SILENCE_THRESHOLD',
  process.env.MIC_SILENCE_THRESHOLD
);
const MIC_SILENCE_THRESHOLD = micThresholdValidation.valid
  ? micThresholdValidation.parsedValue
  : 0.02;

const connRateLimiter = createRateLimiter({
  maxConnections: MAX_CONNECTIONS,
  maxMessagesPerMinute: MAX_MESSAGES_PER_MINUTE,
});

const app = express();
// AJOUT (audit perf) : dashboard.html/dashboard.js (~230 Ko à eux deux)
// étaient servis non compressés. Coût quasi nul en localhost (127.0.0.1 par
// défaut), mais réel dès qu'un second poste rejoint via WS_HOST distant
// (voir config-validator.js) — gzip/brotli sur toutes les réponses HTTP.
app.use(compression());
app.use(express.static(APP_ROOT));
// AJOUT (médiathèque) : overlay.html et dashboard.html sont chargés en
// file:// (voir main.js) — cette route leur donne une URL http:// stable
// pour les fichiers copiés dans <userData>/media/ par media-library.js,
// sur le même principe pont que /api/verses pour les données JSON.
app.use('/media', express.static(path.join(USER_DATA_DIR, 'media')));
// AJOUT (habillage caméra — logo) : même pont que /media ci-dessus, pour le
// logo copié dans <userData>/branding/ par branding-store.js.
app.use('/branding', express.static(path.join(USER_DATA_DIR, 'branding')));
// AJOUT (identité de marque du tableau de bord — revente en produit
// "clé en main") : même pont, pour le logo copié dans
// <userData>/dashboard-branding/ par dashboard-branding-store.js. Route
// distincte de /branding ci-dessus — deux domaines sans recouvrement, voir
// l'en-tête de dashboard-branding-store.js.
app.use('/dashboard-branding', express.static(path.join(USER_DATA_DIR, 'dashboard-branding')));

// SECURITY: origin validation middleware for non-localhost binds
const ALLOWED_ORIGINS = new Set([
  'file://',
  'null',
  `http://localhost:${SERVER_PORT}`,
  `http://127.0.0.1:${SERVER_PORT}`,
]);

// Routes HTTP "cœur" (pages statiques, health/status, données publiques
// pour companion.html) — extraites vers http-routes.js (Phase 2). Enregistrées
// plus bas (registerHttpRoutes()), une fois wss/sessionState/broadcast prêts.

// Caméra téléphone — extrait vers phone-camera-routes.js (D.2)
const phoneCameraRoutes = require('./phone-camera-routes');
const cleanupPhoneCameraStateForItem = phoneCameraRoutes.cleanupPhoneCameraStateForItem;

// Enregistrer les routes HTTP caméra téléphone (auto-contenues avec leur propre état)
phoneCameraRoutes.registerRoutes({
  app,
  phoneCameraPairing,
  ipCameraStore,
  broadcast,
  log,
  warn,
  SERVER_PORT,
});

const httpServer = http.createServer(app);
// SECURITY: auth tokens travel via the Sec-WebSocket-Protocol handshake
// header instead of the ?token= query string. Query strings routinely end
// up in reverse-proxy / CDN access logs, browser process lists, and referer
// headers; the WebSocket subprotocol header does not. `handleProtocols`
// must echo back one of the client-offered values or browsers abort the
// handshake, so we echo whichever of the two known tokens was offered (or
// the first offered value, harmlessly, if auth is disabled).
const wss = new WebSocket.Server({
  server: httpServer,
  maxPayload: 64 * 1024,
  // AJOUT (audit perf) : compression native de `ws`, aucune dépendance
  // supplémentaire. Réduit la taille sur le fil des diffusions verbeuses
  // (transcript complet, réponses sermon-qa, archives) — gratuit en CPU
  // pour de si petits messages, RAS pour les clients navigateur/Electron
  // qui négocient déjà cette extension nativement.
  perMessageDeflate: true,
  handleProtocols: (protocols) => {
    const offered = Array.from(protocols);
    if (offered.includes(WS_AUTH_TOKEN)) return WS_AUTH_TOKEN;
    if (offered.includes(WS_VIEWER_TOKEN)) return WS_VIEWER_TOKEN;
    return offered[0] || false;
  },
});

httpServer.listen(SERVER_PORT, WS_HOST, () => {
  console.log(`[server] Serveur HTTP & WebSocket démarré sur http://${WS_HOST}:${SERVER_PORT}`);
});

httpServer.on('error', (err) => {
  const reason =
    err && err.code === 'EADDRINUSE'
      ? `Le port ${SERVER_PORT} est déjà utilisé par une autre application.`
      : `Erreur du serveur HTTP/WebSocket: ${err && err.message}`;
  console.error('[server] ' + reason);
  if (parentPort) {
    parentPort.postMessage({
      type: 'alert',
      code: 'server-listen-error',
      severity: 'error',
      message: reason,
      timestamp: Date.now(),
    });
  }
  process.exitCode = 1;
  process.exit(1);
});

// ---------------------------------------------------------------------------
// State (voir session-state.js — encapsulé le 2026-08-05, comportement
// identique, accès désormais via des accesseurs plutôt que des `let`
// globaux modifiables depuis n'importe où dans ce fichier)
// ---------------------------------------------------------------------------
const sessionState = require('./session-state');

// Routes HTTP "cœur" — extraites vers http-routes.js (Phase 2, même chantier
// que phone-camera-routes.js ci-dessus). getConsecutiveTranscriptionFailures/
// getLastLiveCaption sont des GETTERS (pas les valeurs) : ces `let` sont
// réassignés en continu pendant que le pipeline tourne (voir plus bas et
// updateLiveCaption()) — leur passer la valeur ici figerait /api/health et
// /api/captions sur un instantané de démarrage.
const httpRoutes = require('./http-routes');
httpRoutes.registerRoutes({
  app,
  appRoot: APP_ROOT,
  appVersion: APP_VERSION,
  serverPort: SERVER_PORT,
  wsAuthToken: WS_AUTH_TOKEN,
  wss,
  asrEngine,
  audioCapture,
  groq,
  bibleLookup,
  sessionState,
  sessionStore,
  getConsecutiveTranscriptionFailures: () => consecutiveTranscriptionFailures,
  getLastLiveCaption: () => lastLiveCaption,
});

// Ambient mood — voir startAmbientMoodLoop() plus bas.
let ambientMoodInterval = null;
let lastAmbientTranscriptCount = 0;
let lastAmbientMood = null;

// ---------------------------------------------------------------------------
// Rate limiter (diffusion de versets)
// ---------------------------------------------------------------------------
const broadcastRateLimiter = createRateLimiter({
  maxConnections: 1,
  maxMessagesPerMinute: 50,
  connectionWindowMs: 60_000,
});
const BROADCAST_LIMIT_KEY = { _socket: { remoteAddress: 'internal-broadcast' } };
function isRateLimited() {
  return !broadcastRateLimiter.checkMessage(BROADCAST_LIMIT_KEY).allowed;
}

// ---------------------------------------------------------------------------
// File de tâches (import PowerPoint pour l'instant — voir task-queue.js)
// ---------------------------------------------------------------------------
const importJobQueue = createTaskQueue({ concurrency: 1, maxPending: 10 });

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------
const fileLogger = createFileLogger(path.join(USER_DATA_DIR, 'logs'));

function log(msg) {
  const line = `[server] ${msg}`;
  console.log(line);
  fileLogger.append(line, false);
  if (parentPort) parentPort.postMessage({ type: 'log', text: line, isError: false });
}
function warn(msg) {
  const line = `[server] ${msg}`;
  console.warn(line);
  fileLogger.append(line, true);
  if (parentPort) parentPort.postMessage({ type: 'log', text: line, isError: true });
}

// ---------------------------------------------------------------------------
// Broadcast to all WebSocket clients
// ---------------------------------------------------------------------------
// AJOUT (support bilingue FR/EN — commande vocale "repeat"/"répète") :
// suivi centralisé ICI (pas à chaque site d'appel de broadcast() —
// impossible d'en oublier un) de la dernière diffusion re-diffusable,
// pour que 'repeat' puisse re-broadcaster le payload exact, sans nouvelle
// recherche. showMedia délibérément inclus (pas seulement showVerse) :
// voir la décision "repeat = verset OU chant OU média" du cahier des
// charges bilingue. showScene (studio de scènes, lot 4) : même raisonnement.
const REPEATABLE_ACTIONS = new Set(['showVerse', 'showMedia', 'showScene']);

// AJOUT (protection contre les clients lents) : un client WebSocket dont le
// buffer d'envoi (bufferedAmount, TCP+userland côté `ws`) grossit signifie
// qu'il consomme plus lentement qu'on ne lui envoie — une connexion lente/
// gelée (overlay OBS sur un poste distant surchargé, tablette Wi-Fi faible).
// Sans protection, ws.send() continue d'empiler en mémoire indéfiniment
// pour CE client, et surtout .forEach() ne saute jamais son tour : un seul
// client à la traîne ne doit jamais retarder ou dégrader l'expérience de
// tous les autres (opérateur y compris) en pleine diffusion.
// Seuil : les messages diffusés ici sont du JSON (texte de verset, scènes
// avec URLs média, listes) — quelques Ko à quelques dizaines de Ko dans le
// pire cas, jamais des médias binaires (servis par HTTP, pas par ce socket).
// 2 Mo est donc un plafond très généreux qui ne se déclenche que pour un
// client réellement bloqué, pas une variation normale de débit.
// Configurable (mêmes conventions que MAX_CONNECTIONS/MAX_MESSAGES_PER_MINUTE,
// voir config-validator.js) — surtout utile en test, pour ne pas avoir à
// gonfler artificiellement 2 Mo de trafic réel pour exercer cette logique.
const WS_BACKPRESSURE_THRESHOLD_BYTES =
  Number(process.env.WS_BACKPRESSURE_THRESHOLD_BYTES) || 2 * 1024 * 1024;
// Un client resté au-dessus du seuil plus longtemps que ça est considéré
// perdu — mieux vaut fermer proprement (il se reconnectera) que de laisser
// grossir indéfiniment la mémoire du process pour une connexion qui ne
// rattrapera probablement jamais son retard.
const WS_BACKPRESSURE_CLOSE_AFTER_MS = Number(process.env.WS_BACKPRESSURE_CLOSE_AFTER_MS) || 5000;

// AJOUT (audit — fuite d'état opérateur vers les connexions viewer) :
// broadcast() envoyait jusqu'ici à TOUS les clients sans distinction de rôle
// — correct pour ce que l'overlay/l'écran de scène affichent réellement
// (showVerse/showMedia/showScene/applyTheme…), mais plusieurs diffusions
// *Updated (médiathèque, groupes média, scènes, chants, caméras IP)
// n'existent que pour resynchroniser un second tableau de bord opérateur
// éventuellement ouvert (voir les commentaires dans media-ws-handlers.js/
// scene-ws-handlers.js/song-ws-handlers.js/camera-ws-handlers.js) — ni
// overlay.html ni stage-display.html/companion.html/branding-overlay.html
// ne les lisent. { operatorOnly: true } restreint l'envoi aux connexions
// ws.clientRole === 'operator' (voir determineClientRole()) sans toucher au
// comportement par défaut (obj seul, comme avant) pour tous les autres
// appels. NE PAS l'utiliser pour 'mediaLibraryUpdated' en dehors de ces
// diffusions de resynchronisation : announcement-loop.html (rôle viewer)
// dépend d'une réponse ws.send() directe à sa propre requête
// 'getMediaLibrary' — un chemin de code entièrement différent, non affecté
// par ce filtre.
function broadcast(obj, opts) {
  if (REPEATABLE_ACTIONS.has(obj.action)) {
    sessionState.setLastBroadcast(obj.action, obj);
  }
  const operatorOnly = !!(opts && opts.operatorOnly);
  const json = JSON.stringify(obj);
  const now = Date.now();
  wss.clients.forEach((ws) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (operatorOnly && ws.clientRole !== 'operator') return;

    if (ws.bufferedAmount > WS_BACKPRESSURE_THRESHOLD_BYTES) {
      if (!ws._backpressureSince) {
        ws._backpressureSince = now;
        warn(
          `Client WebSocket (role: ${ws.clientRole || 'inconnu'}) en retard d'envoi ` +
            `(bufferedAmount=${ws.bufferedAmount} octets > seuil ${WS_BACKPRESSURE_THRESHOLD_BYTES}) — ` +
            "messages ignorés pour ce client tant qu'il ne rattrape pas son retard."
        );
      } else if (now - ws._backpressureSince > WS_BACKPRESSURE_CLOSE_AFTER_MS) {
        warn(
          `Client WebSocket (role: ${ws.clientRole || 'inconnu'}) toujours bloqué après ` +
            `${WS_BACKPRESSURE_CLOSE_AFTER_MS}ms — fermeture forcée (il pourra se reconnecter).`
        );
        ws.terminate();
      }
      return; // Ce client saute ce message — les autres continuent normalement.
    }

    if (ws._backpressureSince) {
      ws._backpressureSince = null; // rattrapé — reprend l'envoi normal, silencieusement
    }
    ws.send(json);
  });
}

// AJOUT (studio de scènes, lot 4/6, étendu lot 5/6) : convertit une scène
// (telle que stockée par scene-store.js — mediaId nus) en payload prêt à
// l'emploi côté client (mediaUrl résolues via media-library.js). Résolution
// faite ICI, côté serveur — jamais confiance au tableau de bord pour une URL
// à jour, voir le plan approuvé. Un mediaId dont l'élément a été supprimé de
// la médiathèque se dégrade proprement : mediaUrl reste absente pour CET
// élément seul (voir renderSceneDom(), qui ignore silencieusement un élément
// sans mediaUrl exploitable), jamais un plantage de la diffusion entière.
// AJOUT (lot 5/6) : utilisée aussi pour sceneLibraryUpdated (liste complète,
// pas seulement le déclenchement ponctuel) — isDefault/addedAt/updatedAt
// désormais préservés, nécessaires à la galerie du tableau de bord (badge
// "Poster", tri) qui ne les lisait pas avant que cette fonction serve aussi
// à peupler la liste.
function resolveSceneMediaUrls(scene) {
  const resolveMediaUrl = (mediaId) => {
    if (!mediaId) return null;
    const item = mediaLibrary.getItem(mediaId);
    return item ? `/media/${item.filename}` : null;
  };

  const background = scene.background || { type: 'none', mediaId: null, color: null };
  return {
    id: scene.id,
    name: scene.name,
    addedAt: scene.addedAt,
    updatedAt: scene.updatedAt,
    isDefault: !!scene.isDefault,
    background: {
      type: background.type,
      // AJOUT (studio de scènes, lot 6/6 — composeur) : mediaId conservé en
      // plus de mediaUrl — même raisonnement que pour les éléments image
      // ci-dessous (spread de el, qui garde déjà mediaId). L'overlay n'utilise
      // que mediaUrl pour l'affichage, mais le composeur du tableau de bord
      // (scene-studio.js#openSceneComposer) en a besoin pour savoir QUEL
      // média de la médiathèque était choisi, et le présélectionner dans son
      // <select> quand on modifie une scène existante.
      mediaId: background.type === 'media' ? background.mediaId || null : null,
      mediaUrl: background.type === 'media' ? resolveMediaUrl(background.mediaId) : null,
      color: background.color,
    },
    elements: (scene.elements || []).map((el) =>
      el.type === 'image' ? { ...el, mediaUrl: resolveMediaUrl(el.mediaId) } : el
    ),
    // AJOUT (déclenchement vocal des scènes) : sans ce champ, la galerie du
    // tableau de bord (badges "🎙 phrase") et le composeur en modification
    // (pré-remplissage de composerPhrasesInput) ne verraient jamais les
    // phrases déclencheuses — sceneLibraryUpdated ne transite QUE par cette
    // fonction, jamais par l'objet brut du store.
    triggerPhrases: scene.triggerPhrases || [],
  };
}

// ---------------------------------------------------------------------------
// AJOUT (chantier 4.3 — feuille de route/cue-list) : déclenche UN repère,
// quel que soit son type — même comportement de diffusion que showVerse/
// triggerMediaItem/triggerScene ci-dessous (delibérément dupliqué plutôt que
// factorisé à l'envers : ces trois actions restent aussi déclenchables
// individuellement, hors feuille de route, donc chacune garde sa propre
// branche ; executeCue() est le SEUL point qui les regroupe pour la feuille
// de route). Ne lève jamais — retourne {ok, error} pour que l'appelant
// puisse continuer d'avancer dans la liste même si un repère échoue (média
// supprimé entre-temps, référence désormais invalide...).
// ---------------------------------------------------------------------------
async function executeCue(cue) {
  try {
    if (cue.type === 'verse') {
      const ref = detector.parseReference(cue.reference);
      if (!ref) return { ok: false, error: `Référence invalide : ${cue.reference}` };
      const verse = await bibleLookup.getVerseMultilang(ref, sessionState.getDisplayLanguage());
      const durationMs = getVerseDurationMs();
      broadcast({ action: 'showVerse', ...verse, durationMs, triggeredManually: true });
      pushHistory({ ...verse, triggeredManually: true, timestamp: Date.now() });
      broadcast({ action: 'historyUpdated', history: sessionState.getVerseHistory() });
      return { ok: true };
    }
    if (cue.type === 'media') {
      const item = mediaLibrary.getItem(cue.mediaId);
      if (!item) return { ok: false, error: `Média introuvable : ${cue.label}` };
      broadcast({
        action: 'showMedia',
        id: item.id,
        mediaType: item.mediaType,
        mediaUrl: `/media/${item.filename}`,
        label: item.label,
        displayDurationMs: item.displayDurationMs,
        transitionStyle: item.transitionStyle,
        detectedBy: 'manual',
      });
      sessionStore.recordVerseShown({
        reference: `📷 ${item.label}`,
        detectedBy: 'media',
        timestamp: Date.now(),
      });
      return { ok: true };
    }
    // cue.type === 'scene'
    const scene = sceneStore.getItem(cue.sceneId);
    if (!scene) return { ok: false, error: `Scène introuvable : ${cue.label}` };
    broadcast({ action: 'showScene', ...resolveSceneMediaUrls(scene), detectedBy: 'manual' });
    sessionStore.recordVerseShown({
      reference: `🎬 ${scene.name}`,
      detectedBy: 'scene',
      timestamp: Date.now(),
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Push to verse history (délègue à session-state.js)
// ---------------------------------------------------------------------------
function pushHistory(entry) {
  sessionState.pushHistory(entry);
  sessionStore.recordVerseShown(entry);
}

// ---------------------------------------------------------------------------
// Reading Mode
// ---------------------------------------------------------------------------
const readingMode = new ReadingMode({
  getChapterVerses: (book, chapter) =>
    bibleLookup.getChapterVersesMultilang(book, chapter, sessionState.getDisplayLanguage()),
  onVerseAdvance: (verse) => {
    const reference = bibleLookup.buildReferenceLabel(
      { book: readingMode.book, chapter: readingMode.chapter, verseStart: verse.num },
      sessionState.getDisplayLanguage()
    );
    broadcast({
      action: 'showVerse',
      reference,
      text: verse.text,
      text_fr: verse.text_fr || null,
      text_en: verse.text_en || null,
      langMode: sessionState.getDisplayLanguage(),
      durationMs: getVerseDurationMs(),
      readingMode: true,
      readingModePos: readingModePosition(readingMode, verse.num),
    });
    pushHistory({
      reference,
      text: verse.text.substring(0, 200),
      readingMode: true,
      timestamp: Date.now(),
    });
    broadcast({ action: 'historyUpdated', history: sessionState.getVerseHistory() });
  },
});

// AJOUT (frontend — mode lecture "pro") : position courante du mode lecture
// (chapitre + numéro de verset + nombre total de versets du chapitre),
// diffusée dans chaque showVerse en mode lecture pour que le tableau de
// bord affiche la progression ("Jean 3 · verset 16/36") sans avoir à
// recompter lui-même les versets du chapitre.
// CORRECTIF (audit — progression trompeuse sur une plage annoncée) : `total`
// valait toujours la longueur du chapitre entier, même quand une plage a été
// annoncée et que le mode lecture s'arrête volontairement avant la fin (voir
// endVerseNumber dans reading-mode.js) — le tableau de bord affichait par ex.
// "verset 6/36" alors que la lecture s'arrêtera à 7, laissant croire à
// l'opérateur qu'il reste 30 versets à suivre. `endVerseNumber` est déjà un
// NUMÉRO de verset (pas un index), cohérent avec `verse` ci-dessous.
function readingModePosition(rm, verseNum) {
  return {
    book: rm.book,
    chapter: rm.chapter,
    verse: verseNum,
    total: rm.endVerseNumber || (rm.verses ? rm.verses.length : 0),
  };
}

async function activateReadingMode(book, chapter, verseStart, verseEnd) {
  try {
    await readingMode.start(book, chapter, verseStart, verseEnd);
  } catch (err) {
    warn('Reading mode: activation impossible pour ' + book + ' ' + chapter + ': ' + err.message);
  }
}

// AJOUT (mode lecture — bouton manuel) : extrait du corps auparavant
// dupliqué dans les case 'nextVerse'/'previousVerse' de
// handleVoiceCommand() ci-dessous — partagé maintenant avec les nouvelles
// actions WS directes 'nextReadingVerse'/'previousReadingVerse' (voir plus
// bas) pour que le déclenchement vocal et le clic manuel avancent de la
// même façon, sans logique divergente entre les deux chemins.
function advanceReadingModeVerse(direction) {
  if (!readingMode.active) return false;
  const nextIndex = readingMode.currentIndex + direction;
  if (nextIndex < 0 || nextIndex >= readingMode.verses.length) return false;
  const verse = readingMode.verses[nextIndex];
  readingMode.currentIndex = nextIndex;
  readingMode.onVerseAdvance(verse);
  return true;
}

// AJOUT (audit fonctionnel — navigation par chapitre) : extrait du corps
// auparavant dupliqué dans les case 'nextChapter'/'previousChapter' de
// handleVoiceCommand() plus bas — partagé maintenant avec les nouvelles
// actions WS directes 'nextReadingChapter'/'previousReadingChapter' (voir
// reading-translation-ws-handlers.js), même principe que
// advanceReadingModeVerse() ci-dessus pour nextReadingVerse/
// previousReadingVerse. Plancher au chapitre 1 ; pas de plafond côté
// conception d'origine (voir le AJOUT bilingue FR/EN sur l'ancien case
// 'previousChapter', non modifié ici, hors périmètre) — un chapitre
// inexistant échoue proprement via activateReadingMode() (try/catch).
async function advanceReadingModeChapter(direction) {
  if (!readingMode.active) return false;
  if (direction < 0 && (readingMode.chapter || 1) <= 1) return false;
  await activateReadingMode(readingMode.book, (readingMode.chapter || 0) + direction, 1);
  if (readingMode.active && readingMode.currentIndex >= 0) {
    readingMode.onVerseAdvance(readingMode.verses[readingMode.currentIndex]);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Prompt injection filter for LLM-bound text
// ---------------------------------------------------------------------------
// CORRECTIF (chantier de découpage 2026-08-05) : server.js définissait sa
// propre copie plus faible de sanitizeForPrompt() (moins de patterns, pas
// de neutralisation des triples backticks) alors que semantic-detector.js,
// transcription-corrector.js et ai-enricher.js utilisent déjà le module
// partagé et plus complet prompt-sanitizer.js. Utilise désormais la même
// défense partout — une seule source de vérité.
const { sanitizeForPrompt } = require('./prompt-sanitizer');

// ---------------------------------------------------------------------------
// AJOUT (Phase 2 — modularisation du dispatch WS) : table de handlers extraits
// par catégorie (voir media-ws-handlers.js et ses pairs à venir), consultée
// EN PREMIER dans le message handler (ws.on('message', ...) plus bas), avant
// la chaîne if/else historique pour les actions pas encore migrées. Construite
// UNE SEULE FOIS au démarrage (pas par message) — chaque module reçoit ses
// dépendances explicitement via un objet de contexte, jamais un accès
// implicite à tout server.js.
// ---------------------------------------------------------------------------
const mediaWsHandlers = require('./media-ws-handlers');
const sceneWsHandlers = require('./scene-ws-handlers');
const songWsHandlers = require('./song-ws-handlers');
const rundownWsHandlers = require('./rundown-ws-handlers');
const cameraWsHandlers = require('./camera-ws-handlers');
const brandingWsHandlers = require('./branding-ws-handlers');
const accessibilityWsHandlers = require('./accessibility-ws-handlers');
const readingTranslationWsHandlers = require('./reading-translation-ws-handlers');
const trustWsHandlers = require('./trust-ws-handlers');
const aiAssistantWsHandlers = require('./ai-assistant-ws-handlers');
const serviceImportExportWsHandlers = require('./service-import-export-ws-handlers');
const coreVerseWsHandlers = require('./core-verse-ws-handlers');
const timerWsHandlers = require('./timer-ws-handlers');
const pluginsExportsWsHandlers = require('./plugins-exports-ws-handlers');
const diagnosticsWsHandlers = require('./diagnostics-ws-handlers');
const miscWsHandlers = require('./misc-ws-handlers');
const agentWsHandlers = require('./agent-ws-handlers');
const CATEGORY_HANDLERS = new Map([
  ...mediaWsHandlers.createHandlers({
    mediaLibrary,
    songLibrary,
    sceneStore,
    voiceTriggerMatcher,
    sessionStore,
    broadcast,
    log,
    resolveSceneMediaUrls,
  }),
  ...sceneWsHandlers.createHandlers({
    sceneStore,
    mediaLibrary,
    sessionStore,
    broadcast,
    log,
    resolveSceneMediaUrls,
  }),
  ...songWsHandlers.createHandlers({
    songLibrary,
    broadcast,
    log,
    broadcastSongSection,
  }),
  ...rundownWsHandlers.createHandlers({
    rundownStore,
    broadcast,
    log,
    getCurrentRundownIndex: () => currentRundownIndex,
    setCurrentRundownIndex: (index) => {
      currentRundownIndex = index;
    },
    getCueTimeline: () => cueTimeline,
    recordCueStart: (cueId) => {
      cueTimeline.set(cueId, Date.now());
    },
    clearCueTimeline: () => {
      cueTimeline = new Map();
    },
    executeCue,
  }),
  ...cameraWsHandlers.createHandlers({
    ipCameraStore,
    cleanupPhoneCameraStateForItem,
    broadcast,
    log,
    wsHost: WS_HOST,
    getLanIpAddress,
    phoneCameraPairing,
    serverPort: SERVER_PORT,
    QRCode,
  }),
  ...brandingWsHandlers.createHandlers({
    brandingStore,
    dashboardBrandingStore,
    sessionState,
    broadcast,
    log,
    getBrandingState,
    getDashboardBrandingState,
  }),
  ...accessibilityWsHandlers.createHandlers({
    sessionState,
    broadcast,
    log,
    startAmbientMoodLoop,
    stopAmbientMoodLoop,
  }),
  ...readingTranslationWsHandlers.createHandlers({
    sessionState,
    bibleLookup,
    detector,
    readingMode,
    themeGenerator,
    aiEnricher,
    sanitizeForPrompt,
    broadcast,
    log,
    pushHistory,
    getVerseDurationMs,
    readingModePosition,
    advanceReadingModeVerse,
    advanceReadingModeChapter,
  }),
  ...trustWsHandlers.createHandlers({
    sessionState,
    getPendingVerse: () => pendingVerse,
    confirmPendingVerse,
    dismissPendingVerse,
    broadcast,
    log,
  }),
  ...aiAssistantWsHandlers.createHandlers({
    semanticSearch,
    themeGenerator,
    aiEnricher,
    semanticDetector,
    corrector,
    plugins,
    aiLoadErrors,
    sessionState,
    sermonArchive,
    sermonQa,
    sanitizeForPrompt,
    log,
    warn,
  }),
  ...serviceImportExportWsHandlers.createHandlers({
    importJobQueue,
    fs,
    pptxImporter,
    sceneStore,
    serviceExport,
    serviceImport,
    rundownStore,
    mediaLibrary,
    songLibrary,
    userDataDir: USER_DATA_DIR,
    getCurrentRundownIndex: () => currentRundownIndex,
    resolveSceneMediaUrls,
    broadcast,
    log,
  }),
  ...coreVerseWsHandlers.createHandlers({
    detector,
    sessionState,
    bibleLookup,
    getVerseDurationMs,
    broadcast,
    pushHistory,
    log,
    warn,
  }),
  ...timerWsHandlers.createHandlers({
    broadcast,
    log,
  }),
  ...pluginsExportsWsHandlers.createHandlers({
    sessionStore,
    highlightExport,
    clipExporter,
    plugins,
    sessionStartedAt: SESSION_STARTED_AT,
    getClipExportInProgress: () => clipExportInProgress,
    setClipExportInProgress: (value) => {
      clipExportInProgress = value;
    },
    broadcast,
    log,
  }),
  ...diagnosticsWsHandlers.createHandlers({
    groq,
    deepgramWrapper,
    wsAuthToken: WS_AUTH_TOKEN,
    wsHost: WS_HOST,
    mediaLibrary,
    brandingStore,
    bibleOfflineCache,
    ipCameraStore,
    sessionStore,
  }),
  ...miscWsHandlers.createHandlers({
    log,
    broadcast,
    enqueueTranscript,
    featuresStore,
    semanticSearch,
    sanitizeForPrompt,
  }),
  ...agentWsHandlers.createHandlers({
    getChurchAgent: () => churchAgent,
  }),
]);

// ---------------------------------------------------------------------------
// Update transcript context for AI features (délègue à session-state.js
// pour le stockage ; le lien avec semanticDetector reste ici car c'est une
// dépendance vers un module IA, pas de l'état de session pur)
// ---------------------------------------------------------------------------
function updateTranscriptContext(text) {
  sessionState.updateTranscriptContext(text);
  if (semanticDetector) semanticDetector.addContext(text);
  sessionState.appendFullServiceTranscript(text);
}

function getRecentContext(maxChars = 300) {
  return sessionState.getRecentContext(maxChars);
}

// ===========================================================================
// Ambient mood — reasoning autonome : le serveur réévalue périodiquement le
// TON du sermon (pas une référence biblique précise) sur les derniers
// fragments transcrits et pousse un changement d'ambiance visuelle sur
// l'overlay EN DIRECT, sans validation de l'opérateur — activé volontairement
// (design.autoLiturgicalTheme, voir config/features.json) car décidé avec
// l'utilisateur. Réutilise exactement le même chemin (themeGenerator.generate
// + broadcast applyTheme) que le changement de thème par verset/commande
// vocale, donc aucun nouveau protocole overlay.
// ===========================================================================
function startAmbientMoodLoop() {
  if (!themeGenerator) return;

  const tick = async () => {
    try {
      const features = featuresStore.readFeatures();
      if (!(features.design || {}).autoLiturgicalTheme) return;

      // Ne relance une analyse que s'il y a eu de la nouvelle parole depuis
      // le dernier cycle (silence prolongé = pas de changement d'ambiance).
      const transcriptCount = sessionState.getRecentTranscripts().length;
      if (transcriptCount === lastAmbientTranscriptCount) return;
      lastAmbientTranscriptCount = transcriptCount;

      const context = getRecentContext(500);
      if (!context.trim()) return;

      const theme = await themeGenerator.generate(context, '', 'auto');
      if (!theme) return;

      const mood = themeGenerator.currentMood;
      if (mood === lastAmbientMood) return; // ambiance inchangée : pas de broadcast
      lastAmbientMood = mood;

      log(`Ambient mood: "${theme.name}" (${mood}) — détecté depuis le ton du sermon`);
      broadcast({ action: 'applyTheme', ...themeGenerator.themeToCss(theme), ambient: true });
    } catch (e) {
      warn('Ambient mood loop error: ' + e.message);
    }
  };

  const features = featuresStore.readFeatures();
  const intervalSec = (features.ai || {}).themeDetection?.intervalSec || 60;
  ambientMoodInterval = setInterval(tick, Math.max(15, intervalSec) * 1000);
  if (ambientMoodInterval.unref) ambientMoodInterval.unref();
}

function stopAmbientMoodLoop() {
  if (ambientMoodInterval) {
    clearInterval(ambientMoodInterval);
    ambientMoodInterval = null;
  }
}

// AJOUT (latence, §14) : journalise le résumé [PERF] d'un énoncé une fois
// son traitement terminé — no-op silencieux si aucun tracker n'a suivi cet
// énoncé (ex. verset saisi manuellement, sans VAD/ASR en amont).
function logLatencySummary(tracker) {
  if (!tracker) return;
  log('\n' + tracker.format());
}

// ===========================================================================
// MAIN PIPELINE: processTranscript
// ===========================================================================
// AJOUT (chantier ASR, Étape 4 — correctif "course de finals") : quand
// l'endpointing découpe la fin d'un énoncé ET le début du suivant en finals
// quasi-simultanés (ex. bloc3 : « chapitre 21 verset 4. » puis, ~10 ms plus
// tard, « Deutéronome chapitre 6 verset »), chaque onFinalTranscript lançait
// un processTranscript() CONCURRENT. Les await internes (corrector IA)
// entrelaçaient alors les deux traitements : le reset par nom de livre du
// fragment suivant (Deutéronome) effaçait le buffer de fusion AVANT que la
// fin de l'énoncé précédent (chapitre 21 verset 4.) ait pu s'y fusionner —
// Apocalypse 21:4 n'était donc JAMAIS reconstruit. On sérialise ici les
// appels (chaîne de promesses) : chaque fragment est traité dans l'ordre
// d'arrivée, et son push + fusion est toujours terminé avant que le fragment
// suivant (qui reset le buffer s'il porte un livre) ne démarre.
let transcriptQueue = Promise.resolve();

// AJOUT (borne de latence — pic observé 372s sur un énoncé) : profondeur du
// transcriptQueue, incrémentée à chaque mise en file et décrémentée une
// fois le traitement réglé (succès ou échec). Sert uniquement à décider si
// la détection sémantique (LLM, potentiellement lente) doit être SAUTÉE
// pour ne pas empiler davantage de retard sur un énoncé déjà en retard —
// voir son usage dans processTranscript ci-dessous. N'affecte pas l'ORDRE
// de traitement, seulement quel travail optionnel s'exécute.
let transcriptQueueDepth = 0;
function getTranscriptQueueDepth() {
  return transcriptQueueDepth;
}

function enqueueTranscript(text, tracker, opts) {
  transcriptQueueDepth++;
  const run = transcriptQueue.then(() => processTranscript(text, tracker, opts));
  transcriptQueue = run.then(
    () => undefined,
    () => undefined
  );
  run.finally(() => {
    transcriptQueueDepth--;
  });
  return run;
}

/**
 * ============================================================================
 * CHANTIER 3 (précision) — Fallback d'affichage du CHAPITRE pour référence
 * partielle (« Jean 14 » sans verset). Règle mission : « jamais une mauvaise
 * référence ; une référence partielle → afficher le verset exact OU le
 * CHAPITRE, jamais un verset faux ». Quand l'ASR ne livre que livre+chapitre
 * (le numéro de verset a été tronqué/perdu — observé sur corpus G1/G2/F2/D7/
 * K5/N2/B1, « Jean 14 » au lieu de « Jean 14.6 »), l'ancien comportement
 * diffusait une candidateVerse et attendait un complément qui n'arrive
 * SOUVENT JAMAIS : rien ne s'affichait jamais. On planifie désormais un
 * timer : si aucun verset exact de ce livre:chapitre n'est affiché dans le
 * délai, on affiche le CHAPITRE ENTIER (getVerseMultilang sans verseStart
 * renvoie tout le chapitre) — correct par construction, jamais un verset
 * faux. Le timer est réarmé à chaque fragment chapitre-seul du même
 * livre:chapitre (le dernier fragment gagne), et ANNULÉ dès qu'un verset
 * exact du livre:chapitre est affiché par le chemin normal.
 * ============================================================================
 */
// AJOUT (Chantier A.5 — mission autonome, arbitrage couverture/latence
// explicite) : mesuré (BASELINE_CHANTIER_1.md, vérifié via git log que
// c'est bien la SEULE variable de latence ayant changé entre les deux
// runs) — ce timer a acheté +13,5 points de couverture (62,2% -> 75,7%) au
// prix de +1,3s de p50 (671ms -> 1949ms). Un délai plus court afficherait
// le chapitre plus tôt mais laisserait moins de temps à un verset EXACT
// (plus précis) d'arriver avant lui ; un délai plus long ferait l'inverse.
// Réglable en direct via config/features.json (display.chapterFallbackDelayMs,
// rechargé à chaque appel — aucun redémarrage requis, même mécanisme que
// getTranscriptionConfidenceThreshold() ci-dessus) ou, à défaut, via la
// variable d'env CHAPTER_FALLBACK_MS pour compat avec les déploiements
// existants. Défaut 3000ms = la valeur mesurée et validée sur ce corpus.
const DEFAULT_CHAPTER_FALLBACK_MS = 3000;
function getChapterFallbackDelayMs() {
  const features = featuresStore.readFeatures();
  const fromFeatures = (features.display || {}).chapterFallbackDelayMs;
  if (typeof fromFeatures === 'number' && Number.isFinite(fromFeatures) && fromFeatures >= 0) {
    return fromFeatures;
  }
  const fromEnv = Number(process.env.CHAPTER_FALLBACK_MS);
  if (Number.isFinite(fromEnv) && fromEnv >= 0) return fromEnv;
  return DEFAULT_CHAPTER_FALLBACK_MS;
}
const chapterFallbackTimers = new Map(); // clé `${book}:${chapter}` -> timerId

function cancelChapterFallback(book, chapter) {
  const key = `${book}:${chapter}`;
  const timer = chapterFallbackTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    chapterFallbackTimers.delete(key);
  }
}

function scheduleChapterFallback(book, chapter, tracker, opts) {
  const key = `${book}:${chapter}`;
  if (chapterFallbackTimers.has(key)) clearTimeout(chapterFallbackTimers.get(key));
  const timer = setTimeout(() => {
    chapterFallbackTimers.delete(key);
    displayChapterFallback(book, chapter, tracker, opts);
  }, getChapterFallbackDelayMs());
  chapterFallbackTimers.set(key, timer);
}

async function displayChapterFallback(book, chapter, tracker, opts) {
  const refKey = `${book}:${chapter}:`;
  const now = Date.now();
  const dedupCtx = {
    utteranceId: tracker && tracker.id != null ? tracker.id : null,
    text: opts && opts.chapterFallbackText ? opts.chapterFallbackText : `${book} ${chapter}`,
    source: 'chapter-fallback',
  };
  if (sessionState.isDuplicateReference(refKey, now, dedupCtx)) {
    log(`Chapter fallback suppressed (dedup): ${refKey}`);
    broadcast({
      action: 'dedupSuppressed',
      ref: refKey,
      reason: 'chapter-fallback',
      timestamp: now,
    });
    return;
  }
  if (isRateLimited()) {
    warn('Rate limit hit — chapter fallback skipped');
    return;
  }
  sessionState.recordShownReference(refKey, now, dedupCtx);
  let verse;
  try {
    verse = await bibleLookup.getVerseMultilang(
      { book, chapter },
      sessionState.getDisplayLanguage()
    );
  } catch (err) {
    warn('Chapter fallback lookup failed: ' + err.message);
    return;
  }
  const durationMs = getVerseDurationMs();

  // AJOUT (Partie 2 — mode confiance) : même raisonnement que
  // processTranscript ci-dessous — finalize capturé en closure, appelé tout
  // de suite en mode 'auto', différé jusqu'à confirmation sinon.
  const finalizeDisplay = async () => {
    broadcast({
      action: 'showVerse',
      reference: verse.reference,
      text: verse.text,
      text_fr: verse.text_fr || null,
      text_en: verse.text_en || null,
      langMode: verse.langMode,
      provider: verse.provider,
      durationMs,
      detectedBy: 'chapter-fallback',
    });
    pushHistory({
      reference: verse.reference,
      text: verse.text.substring(0, 200),
      timestamp: now,
      detectedBy: 'chapter-fallback',
    });
    broadcast({ action: 'historyUpdated', history: sessionState.getVerseHistory() });
    log('Chapter fallback: Displayed ' + verse.reference);
  };

  if (sessionState.getTrustMode() === 'auto') {
    await finalizeDisplay();
  } else {
    setPendingVerse(verse.reference, finalizeDisplay);
    broadcast({
      action: 'pendingVerseConfirmation',
      reference: verse.reference,
      textPreview: verse.text.substring(0, 200),
      trustMode: sessionState.getTrustMode(),
    });
    log(
      `Chapter fallback en attente de confirmation (mode ${sessionState.getTrustMode()}): ${verse.reference}`
    );
  }
}

/**
 * @param {string} text
 * @param {import('./latency-tracker').Tracker} [tracker] - AJOUT (§14) :
 *   suit la latence de CET énoncé à travers détection/Bible/OBS — voir
 *   audio-capture.js (markVadOnset) pour sa création et onAudioSegment/
 *   onFinalTranscript pour son marquage ASR. undefined pour les appels sans
 *   tracker en amont (verset saisi manuellement, voix-commande) — chaque
 *   .mark() ci-dessous est gardé (`tracker &&`), jamais un no-op silencieux
 *   qui masquerait un tracker manquant par erreur.
 */
async function processTranscript(text, tracker, opts = {}) {
  log('Processing transcript: ' + text.substring(0, 100));

  if (plugins) {
    plugins.emit('onTranscript', text).catch(() => {});
  }

  if (detectCommand) {
    try {
      const command = detectCommand(text);
      if (command) {
        log('Voice command detected: ' + command.action);
        await handleVoiceCommand(command, text);
        return;
      }
    } catch (e) {
      warn('Voice command error: ' + e.message);
    }
  }

  // AJOUT (médiathèque — déclenchement vocal de photos/vidéos) : même
  // emplacement et même philosophie de court-circuit que detectCommand()
  // ci-dessus — vérifié sur le texte BRUT (avant correction IA) pour rester
  // aussi immédiat que les commandes vocales, avant la détection de verset.
  try {
    const mediaMatch = mediaLibrary.matchTriggerPhrase(text);
    if (mediaMatch) {
      log('Media cue detected: ' + mediaMatch.label);
      broadcast({
        action: 'showMedia',
        id: mediaMatch.id,
        mediaType: mediaMatch.mediaType,
        mediaUrl: `/media/${mediaMatch.filename}`,
        label: mediaMatch.label,
        displayDurationMs: mediaMatch.displayDurationMs,
        transitionStyle: mediaMatch.transitionStyle,
        detectedBy: 'voice-cue',
      });
      // AJOUT (temps forts exportables — voir highlight-export.js) : best-effort,
      // n'affecte pas la liste "versets récents" du dashboard (voir
      // pushHistory) — uniquement la trace persistante utilisée à l'export.
      sessionStore.recordVerseShown({
        reference: `📷 ${mediaMatch.label}`,
        detectedBy: 'media',
        timestamp: Date.now(),
      });
      return;
    }
  } catch (e) {
    warn('Media cue detection error: ' + e.message);
  }

  // AJOUT (Partie 2.3 — groupes nommés déclenchables à la voix) : même
  // emplacement/philosophie que le média individuel ci-dessus — vérifié
  // APRÈS (une phrase déclencheuse d'un média précis reste prioritaire sur
  // une phrase de groupe plus générale), avant les chants. Affiche le
  // PROCHAIN membre du groupe (rotation, voir matchGroupTriggerPhrase dans
  // media-library.js), jamais tous les membres à la fois.
  try {
    const groupMatch = mediaLibrary.matchGroupTriggerPhrase(text);
    if (groupMatch) {
      log('Media group cue detected: ' + groupMatch.label);
      broadcast({
        action: 'showMedia',
        id: groupMatch.id,
        mediaType: groupMatch.mediaType,
        mediaUrl: `/media/${groupMatch.filename}`,
        label: groupMatch.label,
        displayDurationMs: groupMatch.displayDurationMs,
        transitionStyle: groupMatch.transitionStyle,
        detectedBy: 'voice-cue-group',
      });
      sessionStore.recordVerseShown({
        reference: `📷 ${groupMatch.label}`,
        detectedBy: 'media-group',
        timestamp: Date.now(),
      });
      return;
    }
  } catch (e) {
    warn('Media group cue detection error: ' + e.message);
  }

  // AJOUT (bibliothèque de chants) : même emplacement/philosophie que le
  // médiathèque ci-dessus. Diffusée comme un 'showVerse' synthétique — voir
  // showSongSection() plus bas — donc overlay.html n'a besoin d'aucune
  // logique d'affichage dédiée aux chants.
  try {
    const songMatch = songLibrary.matchTriggerPhrase(text);
    if (songMatch) {
      log('Song cue detected: ' + songMatch.song.title);
      broadcastSongSection(songMatch.song, songMatch.sectionIndex, 'voice-cue');
      return;
    }
  } catch (e) {
    warn('Song cue detection error: ' + e.message);
  }

  // AJOUT (studio de scènes — déclenchement vocal) : même emplacement et
  // même philosophie de court-circuit que la médiathèque/les chants
  // ci-dessus — une scène composée (fond + texte + logo) doit pouvoir être
  // déclenchée en disant simplement son nom (ou une phrase déclencheuse
  // dédiée), exactement comme un média, plutôt que de rester accessible
  // uniquement au clic manuel depuis le tableau de bord.
  try {
    const sceneMatch = sceneStore.matchTriggerPhrase(text);
    if (sceneMatch) {
      log('Scene cue detected: ' + sceneMatch.name);
      broadcast({
        action: 'showScene',
        ...resolveSceneMediaUrls(sceneMatch),
        detectedBy: 'voice-cue',
      });
      sessionStore.recordVerseShown({
        reference: `🎬 ${sceneMatch.name}`,
        detectedBy: 'scene',
        timestamp: Date.now(),
      });
      return;
    }
  } catch (e) {
    warn('Scene cue detection error: ' + e.message);
  }

  let correctedText = text;
  let reference = null;

  // AJOUT (cahier des charges — Point 2, "appel direct") : quand le
  // prédicateur cite une référence explicite et non ambiguë ("Jean 3:16"),
  // detector.detectExact() la reconnaît sur le texte BRUT sans la moindre
  // correction floue — inutile d'attendre l'aller-retour IA de
  // corrector.correct() avant de l'afficher. confidence === 'high'
  // (voir detector.js) signifie précisément "verset explicitement précisé,
  // correspondance exacte" : la même condition que le court-circuit
  // recherché ici. Un match sans verset (confidence 'medium', "chapitre
  // seul") ou une correspondance floue reste sur le pipeline normal
  // ci-dessous, plus prudent pour les cas ambigus.
  // B.2 : les deux détecteurs (FR + EN) sont désormais consultés en
  // parallèle sur le texte brut, et c'est la MEILLEURE correspondance
  // qui gagne (même logique que le repli flou dans detectBilingual).
  try {
    const fastFr = detector.detectExact(text);
    const fastEn = detector.detectExactEn ? detector.detectExactEn(text) : null;
    let fastMatch = null;
    if (fastFr && fastEn) {
      // Les deux ont matché : confidence d'abord, puis pas de verset < avec verset
      if (fastFr.confidence === 'high' && fastEn.confidence !== 'high') fastMatch = fastFr;
      else if (fastEn.confidence === 'high' && fastFr.confidence !== 'high') fastMatch = fastEn;
      else fastMatch = fastFr; // égalité → FR par défaut (langue historique)
    } else {
      fastMatch = fastFr || fastEn;
    }
    if (fastMatch && fastMatch.confidence === 'high') {
      reference = fastMatch;
      log('Appel direct (référence explicite, avant correction IA) : ' + fastMatch.raw);
    }
  } catch (e) {
    warn('Fast-path detection error: ' + e.message);
  }

  if (!reference && corrector) {
    try {
      const defaultMode = (process.env.TRANSCRIPTION_CORRECTOR_MODE || 'fast').toLowerCase();
      const mode = defaultMode === 'smart' && groqHasChatCompletion ? 'smart' : 'fast';
      correctedText = await corrector.correct(text, mode);
      if (correctedText !== text) {
        log('Transcription corrected: ' + correctedText.substring(0, 80) + '...');
        broadcast({ action: 'transcriptCorrected', original: text, corrected: correctedText });
      }
    } catch (e) {
      warn('Transcription correction error: ' + e.message);
    }
  }

  updateTranscriptContext(correctedText);
  // AJOUT (chantier ASR, Étape 4 — reconstruction de références fragmentées) :
  // chaque fragment transcrit (final VAD local, final Deepgram, partial stable
  // relancé) est horodaté dans un buffer glissant (session-state.js) pour
  // pouvoir être FUSIONNÉ si un énoncé a été découpé par l'endpointing en
  // plusieurs finals. La fusion elle-même est tentée ci-dessous, uniquement
  // quand le fragment courant ne suffit pas à produire une référence.
  //
  // CORRECTIF (sonde probe-overwrites) : avant de pousser le fragment, on
  // RESET le buffer dès que ce fragment contient un NOM DE LIVRE — signe
  // qu'un NOUVEL énoncé commence. Sans ce reset, le résidu du fragment
  // précédent (« 13 verset 4. », fin de l'énoncé C1) resterait dans le buffer
  // et se fusionnerait avec le début de l'énoncé suivant (« 2e Timothée
  // chapitre ») → « 2e Timothée chapitre 13 verset 4. » → 2timothee 13:4 FAUX.
  try {
    if (detector.containsBookName(correctedText)) {
      sessionState.resetTranscriptFragments();
    }
  } catch (e) {
    warn('Fragment reset error: ' + e.message);
  }
  sessionState.pushTranscriptFragment(correctedText);

  if (!reference) {
    try {
      reference = detector.detectBilingual(correctedText, sessionState.getTranscriptionLanguage());
    } catch (e) {
      warn('Detector error: ' + e.message);
    }
  }

  // AJOUT (chantier ASR, Étape 4 — reconstruction de références fragmentées) :
  // quand l'ASR a découpé l'énoncé en plusieurs finals (« 1 Corinthiens
  // chapitre » + « 13 verset » + « 13 verset 4. »), aucun fragment seul ne
  // contient la référence complète — le fragment courant échoue donc
  // ci-dessus et rien ne s'affiche jamais (22 énoncés "jamais détectés" du
  // benchmark initial). En FALLBACK UNIQUEMENT (jamais si le fragment courant
  // suffisait), on refait la détection sur le texte FUSIONNÉ des fragments
  // de la fenêtre temporelle (FRAGMENT_FUSION_WINDOW_MS) — et on n'accepte
  // le résultat QUE s'il porte une référence complète (verseStart défini) :
  // une référence "chapitre seul" reconstruite n'est pas plus fiable qu'une
  // vraie et reste soumise à la garde anti-partial-tronqué ci-dessous.
  if (!reference) {
    try {
      const fusedText = sessionState.getFusedRecentText();
      if (fusedText && fusedText !== correctedText) {
        const fusedRef = detector.detectBilingual(
          fusedText,
          sessionState.getTranscriptionLanguage()
        );
        if (fusedRef && fusedRef.book && fusedRef.chapter && fusedRef.verseStart) {
          log(
            `Référence reconstruite par fusion de fragments (« ${fusedText.substring(0, 100)} ») → ${fusedRef.book} ${fusedRef.chapter}:${fusedRef.verseStart}`
          );
          reference = fusedRef;
        } else if (fusedRef && !fusedRef.verseStart) {
          log(
            `Fusion de fragments : référence incomplète (chapitre seul « ${fusedRef.book} ${fusedRef.chapter} ») — non affichée, attente de plus de fragments`
          );
          // AJOUT (Chantier 1 — latence chemin fusion) : on connaît déjà
          // livre+chapitre → on échauffe le cache Bible (par chapitre) pour
          // que l'affichage du verset reconstruit soit instantané.
          bibleLookup
            .getVerseMultilang(
              { book: fusedRef.book, chapter: fusedRef.chapter },
              sessionState.getDisplayLanguage()
            )
            .catch(() => {});
        }
      }
    } catch (e) {
      warn('Fragment fusion error: ' + e.message);
    }
  }

  // AJOUT (chantier ASR, Étape 4 — validation de cohérence du chapitre) :
  // une référence au chapitre INEXISTANT dans le livre (ex. « 2e Timothée
  // chapitre 13 verset 4 » — 2 Timothée n'a que 4 chapitres) est le signe
  // d'une CONTAMINATION inter-énoncés : le résidu du fragment précédent
  // (« 13 verset 4. », fin de C1) a été délivré par l'ASR APRÈS le début de
  // l'énoncé suivant (« 2e Timothée chapitre », début de C2) — le final
  // retardé se fusionne alors par erreur. On rejette la référence ET on
  // retire le résidu fautif du buffer de fusion, pour que le fragment
  // suivant (« 3 verset 16 ») puisse fusionner proprement.
  if (reference && reference.book && reference.chapter) {
    const maxChapter = bibleOfflineCache.CHAPTER_COUNTS[reference.book];
    if (maxChapter && reference.chapter > maxChapter) {
      log(
        `Référence impossible rejetée (${reference.book} n'a que ${maxChapter} chapitres, demande ${reference.chapter}) : résidu d'un énoncé précédent — purge du buffer de fusion`
      );
      try {
        sessionState.removeLastTranscriptFragment();
      } catch (e) {
        warn('Fragment purge error: ' + e.message);
      }
      reference = null;
    }
  }

  // A.7 — validation du numéro de verset : si la base hors-ligne est
  // chargée, on vérifie que le verset demandé existe dans le chapitre.
  // Ex. « Ésaïe 53:17 » → Ésaïe 53 n'a que 12 versets → rejeté. Sans
  // cette garde, le verset passe au-dessus du filtre chapitre (53 ≤ 66)
  // et provoque une erreur API générique ("Verset introuvable") au lieu
  // d'un message explicite. Si la base n'est pas encore chargée, on
  // conserve le comportement historique (pas de validation verset, le <=
  // 200 dans le détecteur reste le seul filet de sécurité).
  if (reference && reference.book && reference.chapter && reference.verseStart) {
    const maxVerse = bibleOfflineCache.getMaxVerse(reference.book, reference.chapter);
    if (maxVerse && reference.verseStart > maxVerse) {
      log(
        `Référence impossible rejetée (${reference.book} ${reference.chapter}:${reference.verseStart} — le chapitre ne contient que ${maxVerse} versets) : verset inexistant`
      );
      try {
        sessionState.removeLastTranscriptFragment();
      } catch (e) {
        warn('Fragment purge error: ' + e.message);
      }
      reference = null;
    }
  }

  // AJOUT (chantier ASR, Étape 4 — énoncé consommé) : une référence COMPLÈTE
  // (livre + chapitre + verset) détectée sur le fragment courant — directe
  // (appel rapide ou detectBilingual) ou reconstruite par fusion — signifie
  // que l'énoncé a été entièrement capturé. On vide alors le buffer de
  // fusion : sans ce reset, le fragment courant reste dans la fenêtre
  // glissante et se REFUSIONNE aux énoncés suivants (« Jean chapitre 3,
  // verset 1 » + texte du verset 2 -> reconstruction erronée « jean 3:1 »,
  // doublon supprimé, avancée de lecture bloquée). Une référence INCOMPLÈTE
  // (chapitre seul) ne vide PAS le buffer : l'énoncé peut encore être
  // découpé par l'endpointing (« chapitre 3 verset » puis « 16 ») et les
  // fragments doivent pouvoir se fusionner quand le verset arrive.
  if (reference && reference.book && reference.chapter && reference.verseStart) {
    try {
      sessionState.resetTranscriptFragments();
    } catch (e) {
      warn('Fragment reset error: ' + e.message);
    }
  }

  if (reference && reference.fuzzy) {
    log(
      `Fuzzy match: "${reference.fuzzyOriginal}" → "${reference.book}" (distance ${reference.fuzzyDistance})`
    );
    broadcast({
      action: 'candidateVerse',
      reference: {
        book: reference.book,
        chapter: reference.chapter,
        verseStart: reference.verseStart,
      },
      original: reference.fuzzyOriginal,
      distance: reference.fuzzyDistance,
    });
  }

  // AJOUT (borne de latence — pic observé 372s sur un énoncé) : le
  // transcriptQueue est sérialisé à dessein (voir plus haut, correctif
  // "course de finals") — un appel LLM lent ici retarde donc TOUS les
  // énoncés déjà en attente derrière lui. Une fois une profondeur de file
  // significative atteinte, on saute la détection sémantique (repli déjà
  // silencieux et attendu, même sémantique que le rate-limit local
  // ci-dessus) plutôt que d'empiler encore du retard sur un backlog déjà
  // en train de se former — la file peut ainsi se vider via les fragments
  // rapides (regex) restants.
  const SEMANTIC_QUEUE_DEPTH_LIMIT = 3;
  const semanticQueueBackedUp = getTranscriptQueueDepth() > SEMANTIC_QUEUE_DEPTH_LIMIT;
  if (!reference && semanticDetector && !semanticQueueBackedUp) {
    try {
      const semanticResult = await semanticDetector.detect(correctedText, { timeoutMs: 4000 });
      if (semanticResult) {
        reference = semanticResult;
        log(
          `Semantic detection: ${semanticResult.raw} (confidence: ${semanticResult.confidence.toFixed(2)})`
        );
        broadcast({
          action: 'semanticDetected',
          reference: semanticResult.raw,
          confidence: semanticResult.confidence,
          reasoning: semanticResult.reasoning,
          alternativeRefs: semanticResult.alternativeRefs,
        });
      }
    } catch (e) {
      warn('Semantic detection error: ' + e.message);
    }
  }

  let quotedMatch = null;
  if (!reference) {
    try {
      const quoted = bibleLookup.findByQuotedText(correctedText);
      if (quoted && quoted.score >= 0.55) {
        log(`Quote match: ${quoted.reference} (score: ${quoted.score.toFixed(2)})`);
        quotedMatch = quoted;
        reference = { book: '', chapter: 0, verseStart: 0, detectedBy: 'quote' };
      }
    } catch (_e) {}
  }

  if (!reference) {
    if (readingMode.active) {
      try {
        const result = readingMode.processFragment(correctedText);
        if (result && result.command === 'nextChapter') {
          const nextChapter = (readingMode.chapter || 0) + 1;
          const book = readingMode.book;
          await activateReadingMode(book, nextChapter, 1);
          if (readingMode.active && readingMode.currentIndex >= 0) {
            const first = readingMode.verses[readingMode.currentIndex];
            const label = bibleLookup.buildReferenceLabel(
              { book, chapter: nextChapter, verseStart: first.num },
              sessionState.getDisplayLanguage()
            );
            broadcast({
              action: 'showVerse',
              reference: label,
              text: first.text,
              text_fr: first.text_fr || null,
              text_en: first.text_en || null,
              langMode: sessionState.getDisplayLanguage(),
              durationMs: getVerseDurationMs(),
              readingMode: true,
              readingModePos: readingModePosition(readingMode, first.num),
            });
            pushHistory({
              reference: label,
              text: first.text.substring(0, 200),
              readingMode: true,
              timestamp: Date.now(),
            });
            broadcast({ action: 'historyUpdated', history: sessionState.getVerseHistory() });
            log('Reading mode: chapitre suivant → ' + label);
          }
        }
      } catch (e) {
        warn('Reading mode processFragment error: ' + e.message);
      }
    }
    return;
  }

  // AJOUT (latence, §14) : référence résolue (exact/fuzzy/sémantique/citation
  // — voir plus haut) — marque la fin de l'étape "détection biblique".
  if (tracker) tracker.mark('scripture');

  // CORRECTIF (Étape 5) : un partial finalisé localement par le silence VAD
  // est fréquemment TRONQUÉ (« Jean chapitre 3 verset » alors que l'énoncé
  // réel est « Jean chapitre 3 verset 16 »). Le promeut-on en « final », la
  // référence résolue est « chapitre seul » (verseStart indéfini) et le repli
  // verse 1 afficherait Jean 3:1 de manière erronée — en écrasant ensuite le
  // bon verset quand le final officiel arrive (course non déterministe).
  // Principe mission : une référence ambiguë n'est jamais affichée
  // aveuglément. On ne l'affiche pas, on diffuse une candidateVerse
  // spéculative, et on attend le final officiel de Deepgram qui est la seule
  // source autoritaire du texte. On ne touche pas au recordShownReference :
  // le vrai final ne sera donc jamais bloqué par le dédoublonnage.
  //
  // AJOUT (chantier ASR, Étape 4) : l'endpointing Deepgram peut AUSSI
  // tronquer un final (« Deutéronome chapitre 6 verset » alors que l'énoncé
  // réel est « Deutéronome chapitre 6 verset 5 » — observé sur bloc3.wav,
  // corpus D7) : le fragment finit sur « verset »/« verse » SANS numéro, et
  //   le repli verse 1 afficherait « Deutéronome 6:1 » faux. Le même traitement
  //   spéculatif s'applique : candidateVerse + attente, pendant que la fusion
  //   de fragments peut reconstruire le numéro manquant (« verset 5 »).
  //
  //   AJOUT (Chantier 1 — précision G1) : un FINAL OFFICIEL DEEPGRAM peut
  //   aussi arriver « chapitre seul » alors que l'énoncé réel contenait un
  //   verset (« Jean 14.6 » → final « Jean 14 », le « 6 » n'est jamais sorti
  //   de l'ASR — observé sur corpus G1). Le repli verse 1 affichait alors
  //   « Jean 14:1 » FAUX. Même traitement spéculatif pour source
  //   'deepgram-final' (chapitre seul = ambigu) : on attend un complément de
  //   texte. La lecture chapitre par chapitre en MODE LECTURE (reading-mode)
  //   n'est pas concernée (chemin distinct).
  //
  //   CORRECTIF (Chantier A.3 — mission autonome) : la restriction aux seules
  //   sources ambiguës laissait un trou sur le chemin segment/batch (source
  //   absente, ex. ASR Groq) : « Jean chapitre 3 » transcrit sans verset y
  //   retombait sur le verset 1 (server.js, ancien displayReference). La
  //   règle mission est ABSOLUE : « quand le numéro de verset n'est pas
  //   identifié avec certitude, ne jamais retomber sur le verset 1 — afficher
  //   le chapitre en repli explicite, ou ne rien afficher ». Aucun chemin
  //   automatique ne fait plus exception. processTranscript() n'est atteint
  //   que par le pipeline vocal (segment batch, partials/finals streaming,
  //   saisie texte du dashboard) — la saisie manuelle "Afficher un Verset"
  //   passe par une autre action (showVerse) qui rend bien tout le chapitre
  //   pour une référence chapitre seule (comportement voulu).
  const truncatedChapterOnly = reference.book && reference.chapter && !reference.verseStart;
  if (truncatedChapterOnly) {
    log(
      "Référence chapitre seul ambiguë (fragment tronqué ou verset absent de l'ASR) — attente du complément"
    );
    broadcast({
      action: 'candidateVerse',
      reference: { book: reference.book, chapter: reference.chapter },
      confidence: 'medium',
      speculative: true,
      original: correctedText,
    });
    // AJOUT (Chantier 1 — latence chemin fusion) : on ne connaît que le
    // chapitre (pas le verset), mais le cache Bible est PAR CHAPITRE : on
    // échauffe le chapitre entier dès maintenant, pour que l'affichage du
    // verset (partial/final suivant, fusion) soit quasi instantané — le fetch
    // réseau à froid (~5s observé sur C1) ne se produit plus sur le chemin
    // d'affichage.
    bibleLookup
      .getVerseMultilang(
        { book: reference.book, chapter: reference.chapter },
        sessionState.getDisplayLanguage()
      )
      .catch(() => {});
    // AJOUT (Chantier 3 — précision G1) : l'attente d'un complément de
    // verset ne doit JAMAIS rester sans affichage (règle mission : référence
    // partielle → verset exact OU chapitre, jamais un verset faux). On
    // planifie l'affichage du CHAPITRE ENTIER si aucun verset exact de ce
    // livre:chapitre n'arrive dans CHAPTER_FALLBACK_MS. Le timer est réarmé
    // à chaque fragment chapitre-seul du même livre:chapitre et annulé dès
    // qu'un verset exact est affiché par le chemin normal (voir la fin de
    // processTranscript). candidateVerse reste diffusé pour le tableau de
    // bord (signal spéculatif), mais l'affichage réel n'est plus tributaire
    // d'un complément qui peut ne jamais venir.
    scheduleChapterFallback(reference.book, reference.chapter, tracker, {
      chapterFallbackText: correctedText,
    });
    return;
  }

  if (isRateLimited()) {
    warn('Rate limit hit — verse display skipped');
    return;
  }

  // CORRECTIF (audit round 9) : pour une détection par citation
  // (`detectedBy: 'quote'`), `reference` est un objet placeholder
  // ({ book: '', chapter: 0, verseStart: 0 }) — la vraie référence n'est
  // connue que via `quotedMatch.reference`. Construire refKey à partir de
  // ces champs vides produisait la même clé "::" pour TOUTE citation
  // reconnue sans référence dite, quel que soit le verset réel. Deux
  // versets différents cités à moins de 30s d'intervalle (cas courant en
  // lecture continue) étaient alors traités comme un doublon : le second
  // verset était silencieusement supprimé sans jamais s'afficher.
  const refKey =
    reference.detectedBy === 'quote' && quotedMatch
      ? `quote:${quotedMatch.reference}`
      : `${reference.book}:${reference.chapter}:${reference.verseStart || ''}`;
  const now = Date.now();
  // AJOUT (Chantier 1 — dédoublonnage par énoncé) : on passe au
  // session-state le contexte d'énoncé (identité du tracker, texte affiché,
  // source) pour qu'il distingue cascade partiel→final du MÊME énoncé
  // (à supprimer), re-émission tardive d'un final officiel Deepgram
  // (à supprimer), et nouvelle intention d'un énoncé distinct (à afficher).
  const dedupCtx = {
    utteranceId: tracker && tracker.id != null ? tracker.id : null,
    text: correctedText,
    source: opts.source || null,
  };
  if (sessionState.isDuplicateReference(refKey, now, dedupCtx)) {
    log('Duplicate suppressed: ' + refKey);
    broadcast({
      action: 'dedupSuppressed',
      ref: refKey,
      reason: dedupCtx.source || 'same-ref',
      timestamp: now,
    });
    return;
  }
  sessionState.recordShownReference(refKey, now, dedupCtx);

  let verse;
  try {
    if (reference.detectedBy === 'quote') {
      const quoted = quotedMatch || bibleLookup.findByQuotedText(correctedText);
      verse = {
        reference: quoted.reference,
        text: quoted.text,
        provider: quoted.provider,
        lang: quoted.lang,
        text_fr: quoted.lang === 'fr' ? quoted.text : null,
        text_en: quoted.lang === 'en' ? quoted.text : null,
        langMode: sessionState.getDisplayLanguage(),
      };
      // Le quote-match ne connaît que le texte tel qu'il a été indexé
      // (une seule langue). En mode bilingue, on retente une résolution
      // structurée de la référence pour obtenir le FR + EN complets.
      if (sessionState.getDisplayLanguage() === 'both') {
        const parsedRef = detector.parseReference(quoted.reference);
        if (parsedRef) {
          try {
            verse = await bibleLookup.getVerseMultilang(parsedRef, 'both');
          } catch (_e) {
            // Garde le fallback mono-langue construit ci-dessus.
          }
        }
      }
    } else {
      // CORRECTIF (audit — "Jean 3 verset 1" affichait tout le chapitre 3) :
      // quand la transcription ne capture pas clairement le numéro de
      // verset (bruit ambiant, parole rapide — la STT n'est jamais
      // parfaite), detector.js retourne une référence "chapitre seul"
      // (verseStart undefined). Depuis le Chantier A.3 (mission autonome),
      // la garde `truncatedChapterOnly` ci-dessus interrompt TOUT chemin
      // automatique à chapitre seul (candidateVerse spéculative + repli
      // chapitre entier) — on ne peut donc plus atteindre ce bloc avec
      // verseStart indéfini : la règle absolue « ne jamais retomber sur le
      // verset 1 » est garantie ici par construction. La saisie manuelle
      // ("Afficher un Verset") passe par l'action WS showVerse (chemin
      // distinct) : un opérateur qui tape "Jean 3" exprès pour une lecture
      // complète obtient toujours le chapitre entier.
      verse = await bibleLookup.getVerseMultilang(reference, sessionState.getDisplayLanguage());
    }
  } catch (err) {
    warn('Bible lookup failed: ' + err.message);
    broadcast({ action: 'error', error: 'Verset introuvable : ' + err.message });
    return;
  }

  // AJOUT (latence, §14) : texte du verset résolu (base locale ou API,
  // voir bibleLookup) — marque la fin de l'étape "lookup Bible".
  if (tracker) tracker.mark('bible');

  if (plugins) {
    plugins.emit('onVerseDetected', { ...verse, reference: verse.reference }).catch(() => {});
  }

  // CORRECTIF (latence — polish) : la génération de thème (appel LLM Groq,
  // voir ai-theme-generator.js) était attendue ICI, avant l'affichage du
  // verset — un aller-retour LLM complet posé entre "référence résolue" et
  // "verset visible sur l'overlay". Elle tourne désormais en arrière-plan :
  // applyTheme part séparément dès qu'elle est prête, sans retarder
  // showVerse. Le champ `theme` du payload showVerse (voir finalizeDisplay
  // plus bas) n'était lu par aucun client (overlay.js ni le dashboard,
  // vérifié avant ce changement — seul le message applyTheme séparé
  // compte réellement) : rien ne dépend de l'attendre ici.
  const theme = null;
  if (themeGenerator) {
    const recentContext = getRecentContext();
    themeGenerator
      .generate(verse.text, recentContext, 'auto')
      .then((generated) => {
        if (generated && (generated.source === 'ai' || generated.mood !== 'default')) {
          log(`Theme applied: "${generated.name}" (${generated.mood || 'default'})`);
          broadcast({ action: 'applyTheme', ...themeGenerator.themeToCss(generated) });
        }
      })
      .catch((e) => {
        warn('Theme generation error: ' + e.message);
      });
  }

  const features = featuresStore.readFeatures();
  const multiScene = (features.broadcast || {}).multiScene || {};
  if (multiScene.enabled && !sessionState.getObsGate().open) {
    log('OBS gate closed — verse buffered: ' + verse.reference);
    broadcast({
      action: 'verseBuffered',
      reference: verse.reference,
      reason: sessionState.getObsGate().reason,
    });
    return;
  }

  const durationMs = getVerseDurationMs();

  // AJOUT (Partie 2 — mode confiance) : ce qui affiche RÉELLEMENT le verset
  // (broadcast showVerse + toute la tenue à jour qui suit) est capturé ici
  // en closure plutôt qu'exécuté immédiatement — en mode 'auto' (défaut,
  // comportement historique inchangé), on l'appelle tout de suite ci-dessous ;
  // en 'semi-auto'/'manual', server.js la garde en attente (voir
  // setPendingVerse) et ne l'appelle que si l'opérateur confirme
  // (action WS confirmPendingVerse).
  const finalizeDisplay = async () => {
    broadcast({
      action: 'showVerse',
      reference: verse.reference,
      text: verse.text,
      text_fr: verse.text_fr || null,
      text_en: verse.text_en || null,
      langMode: verse.langMode,
      provider: verse.provider,
      durationMs,
      detectedBy: reference.detectedBy || 'regex',
      matchedByQuote: reference.detectedBy === 'quote',
      theme: theme ? { name: theme.name, mood: theme.mood } : null,
    });

    // AJOUT (latence, §14) : verset diffusé à l'overlay/OBS — dernière étape
    // du pipeline, marque la fin de mesure de cet énoncé (voir logLatencySummary).
    if (tracker) tracker.mark('obs');

    // AJOUT (pont ProPresenter — envoi automatique des versets détectés) :
    // relayé à main.js (seul endroit avec accès à safeStorage/propresenter-
    // controller.js) via le même canal parentPort déjà utilisé pour
    // audio-pipeline-ready/status. Ne couvre QUE ce chemin de détection
    // automatique (le chemin dominant en usage réel) — pas les versets
    // envoyés manuellement/depuis la file d'attente, pour garder ce lot de
    // fonctionnalités raisonnable en taille (voir plan).
    if (parentPort) {
      parentPort.postMessage({
        type: 'verse-shown',
        verse: { reference: verse.reference, text: verse.text },
      });
    }

    pushHistory({
      reference: verse.reference,
      text: verse.text.substring(0, 200),
      timestamp: now,
      detectedBy: reference.detectedBy || 'regex',
    });
    broadcast({ action: 'historyUpdated', history: sessionState.getVerseHistory() });

    if (plugins) {
      plugins.emit('onVerseShown', { ...verse, reference: verse.reference }).catch(() => {});
    }

    log('Displayed: ' + verse.reference);

    // AJOUT (Chantier 3 — précision G1) : un verset EXACT vient d'être affiché
    // pour ce livre:chapitre — le fallback chapitre (voir truncatedChapterOnly)
    // devient inutile et doit être annulé, sinon il afficherait le chapitre
    // entier quelques secondes après le verset.
    if (reference.book && reference.chapter) {
      cancelChapterFallback(reference.book, reference.chapter);
    }

    if (reference.book && reference.chapter) {
      await activateReadingMode(
        reference.book,
        reference.chapter,
        reference.verseStart || 1,
        reference.verseEnd
      );
    }
  };

  // CORRECTIF (course fallback chapitre vs confirmation en attente) : dès
  // qu'un verset EXACT est trouvé, le fallback chapitre pour ce
  // livre:chapitre est obsolète — QUEL QUE SOIT le mode de confiance. En
  // mode 'auto', finalizeDisplay() l'annule déjà lui-même (ci-dessus) ;
  // mais en 'semi-auto'/'manual', finalizeDisplay() n'est appelé qu'APRÈS
  // confirmation opérateur (voir setPendingVerse plus bas) — pendant ce
  // délai, un timer de fallback chapitre déjà armé (par un fragment
  // "chapitre seul" antérieur) pouvait encore se déclencher et afficher le
  // CHAPITRE ENTIER par-dessus le verset en attente de confirmation. On
  // annule donc ici, immédiatement, dès que le verset précis est connu —
  // pas seulement une fois confirmé.
  if (reference.book && reference.chapter) {
    cancelChapterFallback(reference.book, reference.chapter);
  }

  if (sessionState.getTrustMode() === 'auto') {
    await finalizeDisplay();
  } else {
    setPendingVerse(verse.reference, finalizeDisplay);
    broadcast({
      action: 'pendingVerseConfirmation',
      reference: verse.reference,
      textPreview: verse.text.substring(0, 200),
      trustMode: sessionState.getTrustMode(),
    });
    log(
      `Verset en attente de confirmation (mode ${sessionState.getTrustMode()}): ${verse.reference}`
    );
  }
}

// ===========================================================================
// Voice Command Handler
// ===========================================================================
async function handleVoiceCommand(command, _originalText) {
  switch (command.action) {
    case 'showVerse': {
      if (!command.reference) return;
      try {
        const verse = await bibleLookup.getVerseMultilang(
          command.reference,
          sessionState.getDisplayLanguage()
        );
        broadcast({
          action: 'showVerse',
          ...verse,
          durationMs: getVerseDurationMs(),
          triggeredByVoice: true,
        });
        pushHistory({ ...verse, triggeredByVoice: true, timestamp: Date.now() });
        broadcast({ action: 'historyUpdated', history: sessionState.getVerseHistory() });
        log('Voice command: showed ' + verse.reference);
      } catch (err) {
        warn('Voice command verse lookup failed: ' + err.message);
      }
      break;
    }
    case 'hideVerse':
      broadcast({ action: 'hideVerse', triggeredByVoice: true });
      log('Voice command: hide overlay');
      break;
    // AJOUT (support bilingue FR/EN, cahier des charges section 9) :
    // voice-commands.js détectait déjà 'recallLastVerse' ("ramène",
    // "reviens"...) mais AUCUN case ici ne le traitait — commande
    // silencieusement morte, tombait dans le `default` ci-dessous sans
    // aucun effet ni message d'erreur visible. Reprend le DERNIER VERSET
    // (pas la dernière diffusion quelconque — voir 'repeat' ci-dessous
    // pour ça) depuis l'historique déjà tenu par sessionState, en
    // refaisant une vraie recherche (l'historique ne stocke qu'un texte
    // tronqué à 200 caractères, pas le payload complet — contrairement à
    // 'repeat', qui a le payload exact).
    case 'recallLastVerse': {
      const history = sessionState.getVerseHistory();
      const last = history && history[0];
      if (!last || !last.reference) {
        log('Voice command recallLastVerse: aucun verset dans l’historique.');
        break;
      }
      const ref = detector.parseReference(last.reference);
      if (!ref) {
        warn('Voice command recallLastVerse: référence historique illisible: ' + last.reference);
        break;
      }
      try {
        const verse = await bibleLookup.getVerseMultilang(ref, sessionState.getDisplayLanguage());
        broadcast({
          action: 'showVerse',
          ...verse,
          durationMs: getVerseDurationMs(),
          triggeredByVoice: true,
        });
        pushHistory({ ...verse, triggeredByVoice: true, timestamp: Date.now() });
        broadcast({ action: 'historyUpdated', history: sessionState.getVerseHistory() });
      } catch (err) {
        warn('Voice command recallLastVerse error: ' + err.message);
      }
      break;
    }
    // AJOUT (support bilingue FR/EN, décision explicite — "repeat" est
    // large : verset OU chant OU média, pas seulement le dernier verset).
    // Re-diffuse le payload EXACT de la dernière diffusion re-diffusable
    // (voir REPEATABLE_ACTIONS/broadcast() plus haut) — aucune nouvelle
    // recherche nécessaire, contrairement à recallLastVerse ci-dessus.
    case 'repeat': {
      const last = sessionState.getLastBroadcast();
      if (!last) {
        log('Voice command repeat: rien à répéter pour le moment.');
        break;
      }
      broadcast({ ...last.payload, triggeredByVoice: true });
      break;
    }
    case 'nextVerse': {
      broadcast({ action: 'nextVerse', triggeredByVoice: true });
      advanceReadingModeVerse(1);
      break;
    }
    case 'previousVerse': {
      broadcast({ action: 'previousVerse', triggeredByVoice: true });
      advanceReadingModeVerse(-1);
      break;
    }
    case 'nextChapter': {
      broadcast({ action: 'nextChapter', triggeredByVoice: true });
      await advanceReadingModeChapter(1);
      break;
    }
    case 'previousChapter': {
      broadcast({ action: 'previousChapter', triggeredByVoice: true });
      await advanceReadingModeChapter(-1);
      break;
    }
    case 'setTheme': {
      if (themeGenerator) {
        const theme = themeGenerator.getTheme(command.theme);
        broadcast({
          action: 'applyTheme',
          ...themeGenerator.themeToCss(theme),
          triggeredByVoice: true,
        });
        log('Voice command: theme ' + command.theme);
      }
      break;
    }
    case 'setLanguage': {
      sessionState.setDisplayLanguage(command.language);
      broadcast({
        action: 'languageChanged',
        language: sessionState.getDisplayLanguage(),
        triggeredByVoice: true,
      });
      log('Voice command: language ' + command.language);
      break;
    }
    // AJOUT (support bilingue FR/EN, section 13 du cahier des charges) :
    // langue de TRANSCRIPTION (ce que l'ASR doit décoder), jamais la
    // langue d'AFFICHAGE gérée par 'setLanguage' juste au-dessus — ce
    // handler n'appelle JAMAIS sessionState.setDisplayLanguage(), c'est la
    // règle centrale de ce chantier. Diffusion distincte
    // (transcriptionLanguageChanged, pas languageChanged) pour que le
    // tableau de bord puisse un jour afficher les deux états séparément
    // sans les confondre.
    case 'setTranscriptionLanguage': {
      sessionState.setTranscriptionLanguage(command.language);
      broadcast({
        action: 'transcriptionLanguageChanged',
        language: sessionState.getTranscriptionLanguage(),
        triggeredByVoice: true,
      });
      log('Voice command: transcription language ' + command.language);
      break;
    }
    case 'setTranslation': {
      try {
        const newId = bibleLookup.setTranslation(command.language, command.code);
        broadcast({
          action: 'translationChanged',
          language: command.language,
          code: command.code,
          translationId: newId,
          triggeredByVoice: true,
        });
        log(`Voice command: translation ${command.language} → ${command.code}`);
      } catch (err) {
        warn('Voice command translation failed: ' + err.message);
      }
      break;
    }
    case 'extendTime':
      broadcast({ action: 'extendTime', extraMs: command.extraMs, triggeredByVoice: true });
      break;
    case 'pauseTimer':
      broadcast({ action: 'pauseTimer', triggeredByVoice: true });
      break;
    case 'resumeTimer':
      broadcast({ action: 'resumeTimer', triggeredByVoice: true });
      break;
    case 'emergencyClear': {
      broadcast({ action: 'hideVerse', emergency: true });
      broadcast({ action: 'emergencyClear' });
      sessionState.clearLastReference();
      log('Voice command: EMERGENCY CLEAR');
      break;
    }
    default:
      warn('Unknown voice command action: ' + command.action);
  }
}

// AJOUT (raccourcis clavier globaux — recommandation "hotkeys" façon OBS) :
// déclenché par main.js via worker.postMessage({type:'hotkey-action', ...}),
// PAS par le pipeline vocal (pas de triggeredByVoice ici, pour ne pas
// afficher à tort "commande vocale détectée" côté overlay/dashboard alors
// que c'est un raccourci clavier). Volontairement un tout petit sous-
// ensemble d'actions sûres, sans dépendance à un état côté client (la file
// d'attente de versets, par exemple, ne vit que dans le tableau de bord —
// un raccourci global (process principal) n'y a pas accès).
function handleHotkeyAction(action) {
  switch (action) {
    case 'emergencyClear':
      broadcast({ action: 'hideVerse', emergency: true });
      broadcast({ action: 'emergencyClear' });
      sessionState.clearLastReference();
      log('Hotkey: EMERGENCY CLEAR');
      break;
    case 'hideVerse':
      broadcast({ action: 'hideVerse' });
      log('Hotkey: masquer le verset');
      break;
    case 'hideMedia':
      broadcast({ action: 'hideMedia' });
      log('Hotkey: masquer le média');
      break;
    case 'hideScene':
      broadcast({ action: 'hideScene' });
      log('Hotkey: masquer la scène');
      break;
    default:
      warn('Unknown hotkey action: ' + action);
  }
}

// AJOUT (bibliothèque de chants) : diffuse une section de chant comme un
// 'showVerse' synthétique — reference = "Titre — Étiquette", text = paroles
// de la section. Réutilise TOUT le pipeline d'affichage existant côté
// overlay.html (carte, thème, timer) sans lui ajouter le moindre code dédié
// aux chants. durationMs volontairement absent : sanitizeDurationMs() côté
// overlay applique le même défaut généreux (2 min) que pour un verset,
// largement suffisant pour un couplet/refrain chanté, et l'opérateur peut
// avancer manuellement à la section suivante à tout moment.
function broadcastSongSection(song, sectionIndex, detectedBy) {
  const section = song.sections[sectionIndex];
  if (!section) return;
  const reference = `${song.title} — ${section.label}`;
  broadcast({
    action: 'showVerse',
    reference,
    text: section.text,
    text_fr: null,
    text_en: null,
    langMode: 'fr',
    provider: 'song-library',
    detectedBy,
  });
  // AJOUT (temps forts exportables — voir highlight-export.js) : les chants
  // réutilisaient déjà entièrement l'affichage 'showVerse' mais n'étaient
  // jamais enregistrés dans l'historique (ni mémoire ni disque) — absents
  // de la liste "versets récents" ET de tout export après le culte.
  pushHistory({ reference, text: section.text, detectedBy, timestamp: Date.now() });
}

// AJOUT (habillage caméra — logo/titre) : assemble l'état complet envoyé à
// chaque connexion ('init') et à chaque changement ('brandingUpdate') —
// logo/position (persistés, branding-store.js) + titre/sous-titre/visible
// (session en cours, session-state.js). Un seul point de vérité pour ne pas
// répéter cet assemblage à chaque handler ci-dessous.
function getBrandingState() {
  const config = brandingStore.getConfig();
  const text = sessionState.getBrandingText();
  return {
    logoUrl: config.logoFilename ? `/branding/${config.logoFilename}` : null,
    logoType: config.logoType,
    position: config.position,
    size: config.size,
    title: text.title,
    subtitle: text.subtitle,
    visible: sessionState.getBrandingVisible(),
  };
}

// AJOUT (identité de marque du tableau de bord — revente en produit "clé en
// main") : assemble l'état complet envoyé à chaque connexion ('init') et à
// chaque changement ('dashboardBrandingUpdate') — même principe que
// getBrandingState() ci-dessus, pour un domaine différent (voir l'en-tête
// de dashboard-branding-store.js).
function getDashboardBrandingState() {
  const config = dashboardBrandingStore.getConfig();
  return {
    organizationName: config.organizationName,
    accentColor: config.accentColor,
    logoUrl: config.logoFilename ? `/dashboard-branding/${config.logoFilename}` : null,
  };
}

// ===========================================================================
// WebSocket handlers — with RBAC
// ===========================================================================

// Actions that require operator role
//
// CORRECTIF (deux audits indépendants convergents — round 8 et audit
// production de cette même session) : cette liste ne couvrait pas toutes
// les actions qui donnent en pratique un contrôle équivalent à l'opérateur,
// ou qui consomment du quota IA payant / exposent le contenu de la
// prédication. Les deux audits sont arrivés séparément à la même
// conclusion sur 'transcript' et les actions IA (getLiveSummary/
// getSermonTheme/getPostServiceRecap/getCrossReferences) : un client
// connecté avec seulement WS_VIEWER_TOKEN (le jeton prévu pour être collé,
// en lecture seule, dans une source navigateur OBS — donc plus exposé
// qu'un poste opérateur) et utilisant le protocole WebSocket brut (pas
// overlay.html, qui n'envoie jamais ces actions, mais un client fait à la
// main) pouvait :
//  - envoyer `transcript` directement : traité exactement comme un vrai
//    segment audio par processTranscript(), donc afficher n'importe quel
//    verset, changer de thème, déclencher emergencyClear, appeler le
//    détecteur sémantique (LLM) — un contournement complet du RBAC.
//  - appeler `preServiceCheck` : révèle wsHost et si l'authentification est
//    activée, en plus de solliciter les API Groq/Deepgram.
//  - appeler getLiveSummary / getSermonTheme / getPostServiceRecap /
//    getCrossReferences / getArchiveMatches : déclenchent des appels IA
//    payants (Groq/Gemini) et renvoient un résumé du contenu de la
//    prédication ; getPostServiceRecap a en plus un effet de bord réel —
//    elle ARCHIVE le culte et RÉINITIALISE fullServiceTranscript (voir
//    sermon-archive.js), donc un viewer l'appelant par erreur ou malice
//    perdrait la suite de la transcription du jour.
//  - basculer setHighContrast/setCaptions/setTestPattern/
//    setBackgroundPattern : setTestPattern en particulier peut
//    littéralement figer l'écran projeté avec des barres de couleur en
//    pleine prédication.
// Les actions restées hors de cette liste (getTopics, getMoods,
// listPlugins, getAiStats, ping, setTranslation en lecture via
// 'getState'…) restent volontairement accessibles aux viewers : elles ne
// renvoient que des données statiques/publiques ou des métadonnées déjà
// visibles côté overlay.
// CORRECTIF (branchement action-registry.js — source unique de vérité,
// voir action-registry.js) : cet ensemble était auparavant une liste
// dupliquée à la main, désynchronisée du registre sans qu'aucun test ne
// le détecte (deux entrées 'obs-toggle-recording'/'obs-switch-scene'
// s'y trouvaient alors qu'il s'agit de canaux IPC Electron — voir
// preload.js — jamais d'actions WS ; elles ne faisaient donc rien ici).
// Toute action ajoutée au trust tier opérateur doit maintenant l'être
// via `operatorOnly: true` dans action-registry.js, pas ici.
const OPERATOR_ACTIONS = new Set(actionRegistry.listOperatorOnlyActions());

// SECURITY: role is derived from WHICH token the client authenticated with
// (ws.protocol, set by the handshake), never from the request path. The old
// path-based heuristic let any client asking for `/` get 'operator' — the
// shared WS_AUTH_TOKEN was the only real gate, so a leaked/observed overlay
// URL (meant to be read-only, e.g. displayed on a public projector machine)
// still granted full operator control once WS_AUTH_TOKEN was known.
function determineClientRole(ws) {
  if (WS_AUTH_TOKEN && ws.protocol === WS_AUTH_TOKEN) return 'operator';
  if (WS_VIEWER_TOKEN && ws.protocol === WS_VIEWER_TOKEN) return 'viewer';
  if (!WS_AUTH_TOKEN) return 'operator'; // no auth configured (local-only default): unrestricted, as before
  return 'viewer'; // authenticated with neither known token shouldn't reach here (connection is closed earlier)
}

// SECURITY NOTE: this is defense-in-depth against browser-based cross-site
// WebSocket hijacking, not the primary access control — a non-browser
// client can set (or omit) any Origin header it likes, so `!origin` and
// the 'null'/'file://' allowances below are trivially satisfied by a
// deliberate attacker. The real gate for non-local binds is the mandatory
// WS_AUTH_TOKEN/WS_VIEWER_TOKEN check enforced right after this call.
function validateOrigin(req) {
  if (WS_HOST === '127.0.0.1' || WS_HOST === 'localhost') {
    return true; // localhost binds are inherently single-machine
  }
  const origin = req.headers.origin || '';
  if (!origin) return true; // native/file:// clients have no origin
  // CORRECTIF (modularisation backend — sécurité) : origin.startsWith(allowed)
  // acceptait tout origin ayant un des ALLOWED_ORIGINS comme PRÉFIXE — un
  // Origin forgé comme "http://localhost:<port>.attacker.example" passait
  // ce contrôle (préfixe exact), alors que ce n'est ni localhost ni le port
  // configuré. Les entrées de ALLOWED_ORIGINS sont des origines complètes
  // (schéma+hôte+port, jamais un préfixe partiel voulu), donc une
  // comparaison EXACTE est strictement correcte ici — un en-tête Origin ne
  // contient jamais de chemin/segment supplémentaire à tolérer. Rappel du
  // commentaire ci-dessus : ceci reste une défense en profondeur, le
  // véritable contrôle d'accès pour un bind non local est le jeton
  // WS_AUTH_TOKEN/WS_VIEWER_TOKEN vérifié juste après cet appel.
  return ALLOWED_ORIGINS.has(origin);
}

wss.on('connection', (ws, req) => {
  const origin = req && req.headers && req.headers.origin;
  if (origin) {
    log(`Connexion WebSocket acceptée depuis l'origine : ${origin}`);
  }

  // SECURITY: origin validation for non-localhost
  if (!validateOrigin(req)) {
    warn(`Connexion refusée — origine non autorisée : ${origin}`);
    ws.close(1008, 'Origine non autorisée');
    return;
  }

  const connCheck = connRateLimiter.checkConnection(ws);
  if (!connCheck.allowed) {
    warn(`Connexion refusée — ${connCheck.reason}`);
    ws.close(1008, connCheck.reason);
    return;
  }

  // SECURITY: token now comes from the Sec-WebSocket-Protocol handshake
  // header (see `handleProtocols` above), resolved by the `ws` library into
  // `ws.protocol`, not from a `?token=` query string — this keeps it out of
  // proxy/CDN access logs and server request-URL logging.
  if (WS_AUTH_TOKEN || WS_VIEWER_TOKEN) {
    const presented = ws.protocol || null;
    const validTokens = [WS_AUTH_TOKEN, WS_VIEWER_TOKEN].filter(Boolean);
    if (!presented || !validTokens.includes(presented)) {
      warn("Connexion WebSocket refusée — jeton d'authentification invalide ou manquant.");
      connRateLimiter.removeConnection(ws);
      ws.close(1008, 'Non autorisé');
      return;
    }
  }

  // Assign role
  ws.clientRole = determineClientRole(ws);
  log(`Client WebSocket connecté (role: ${ws.clientRole})`);

  const features = featuresStore.readFeatures();
  const theme = themeLoader.getActiveTheme();

  ws.send(
    JSON.stringify({
      action: 'init',
      language: sessionState.getDisplayLanguage(),
      highContrast: sessionState.getHighContrast(),
      captions: sessionState.getCaptionsEnabled(),
      translatedCaptions: sessionState.getTranslatedCaptionsEnabled(),
      captionTargetLang: sessionState.getCaptionTargetLang(),
      testPattern: sessionState.getTestPattern(),
      backgroundPattern: sessionState.getBackgroundPattern(),
      defaultMedia: mediaLibrary.getDefaultItem(),
      // AJOUT (studio de scènes, lot 4/6) : même raisonnement que defaultMedia
      // ci-dessus — à l'ouverture/rechargement de l'overlay, la scène
      // principale (si une existe) doit s'afficher immédiatement sans
      // attendre un premier déclenchement. Résolue (mediaUrl, pas mediaId
      // nus) pour le même motif que resolveSceneMediaUrls() plus haut.
      defaultScene: (() => {
        const scene = sceneStore.getDefaultScene();
        return scene ? resolveSceneMediaUrls(scene) : null;
      })(),
      branding: getBrandingState(),
      dashboardBranding: getDashboardBrandingState(),
      history: sessionState.getVerseHistory(),
      theme: themeLoader.themeToCss(theme),
      features,
      translations: bibleLookup.listTranslations(),
      secondaryTranslation: sessionState.getSecondaryTranslation(),
      trustMode: sessionState.getTrustMode(),
      plugins: plugins ? plugins.getPluginList() : [],
      aiFeatures: {
        semanticDetection: !!semanticDetector,
        voiceCommands: !!detectCommand,
        transcriptionCorrection: !!corrector,
        dynamicThemes: !!themeGenerator,
        bibleSearch: !!semanticSearch,
      },
      aiLoadErrors: aiLoadErrors.length > 0 ? aiLoadErrors : undefined,
      yourRole: ws.clientRole,
    })
  );

  ws.on('message', async (raw) => {
    const msgCheck = connRateLimiter.checkMessage(ws);
    if (!msgCheck.allowed) {
      warn(`Message rejeté — ${msgCheck.reason}`);
      return;
    }

    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    const sanitized = {};
    for (const k of Object.keys(msg)) {
      if (typeof msg[k] === 'string') {
        sanitized[k] = msg[k].replace(/[<>">']/g, '');
      } else {
        sanitized[k] = msg[k];
      }
    }

    // CORRECTIF (audit sécurité — flood par type de message) : la vérif
    // globale ci-dessus (checkMessage(ws)) protège contre un flood générique
    // par IP, mais pas contre un client autorisé qui enverrait uniquement
    // des `showVerse` en rafale (jamais assez pour la limite globale, mais
    // assez pour perturber l'affichage devant l'assemblée). On ajoute donc
    // une seconde vérification, spécifique à l'action, maintenant que
    // `sanitized.action` est connu (le JSON est parsé au-dessus).
    const actionCheck = connRateLimiter.checkMessage(ws, sanitized.action);
    if (!actionCheck.allowed) {
      warn(`Action '${sanitized.action}' rejetée — ${actionCheck.reason}`);
      ws.send(JSON.stringify({ action: 'error', error: actionCheck.reason }));
      return;
    }

    // RBAC: viewer connections cannot send operator actions
    if (ws.clientRole === 'viewer' && OPERATOR_ACTIONS.has(sanitized.action)) {
      warn(`Action '${sanitized.action}' refusée — rôle 'viewer' insuffisant`);
      ws.send(JSON.stringify({ action: 'error', error: 'Action réservée aux opérateurs.' }));
      return;
    }

    // CORRECTIF (audit backend — validation.js jamais branché) : pour les
    // actions déjà couvertes par validation.SCHEMAS (voir validation.js —
    // Phase 1F terminée, les 103 actions client de action-registry.js y
    // sont toutes couvertes), on applique en plus le contrôle strict de
    // type/longueur/valeurs autorisées de ce module. Fait volontairement de
    // façon additive : une action qui perdrait sa couverture resterait
    // fonctionnelle (voir test 38 de test-validation.js pour le garde-fou
    // inverse — aucune action ne doit manquer de schéma).
    if (VALIDATE_MESSAGES_ENABLED && validation.SCHEMAS[sanitized.action]) {
      const strict = validation.validateMessage(sanitized);
      if (!strict.valid) {
        warn(`Message '${sanitized.action}' rejeté par validation.js — ${strict.error}`);
        ws.send(JSON.stringify({ action: 'error', error: strict.error }));
        return;
      }
    }

    // AJOUT (Phase 1G — corrélation requête/réponse) : un client (ex.
    // mcp/church-ws-client.js#callAction) peut joindre un requestId à sa
    // requête pour distinguer SA réponse de celle d'une autre requête
    // concurrente de MÊME type d'action — jusqu'ici, un client devait
    // deviner par ordre d'arrivée/type de message, fragile dès que deux
    // requêtes du même type sont en vol en même temps (voir l'ancien
    // en-tête de church-ws-client.js, qui documentait explicitement cette
    // limite comme acceptée faute de mieux). requestId est validé plus haut
    // (validation.js, autorisé sur toute action) — repris tel quel ici,
    // uniquement pour les actions qui l'échoient dans leur réponse
    // (voir chaque handler concerné ci-dessous ; tous ne le font pas encore
    // — adoption progressive, sans effet sur les clients qui n'en envoient
    // pas, c'est-à-dire tout le tableau de bord aujourd'hui).
    const requestId = typeof sanitized.requestId === 'string' ? sanitized.requestId : null;
    // Petit utilitaire pour les handlers ci-dessous qui échoient requestId
    // (voir chacun) : évite de répéter "if (requestId) obj.requestId = ..."
    // à chaque envoi d'erreur pour ces actions-là.
    function sendError(error) {
      const obj = { action: 'error', error };
      if (requestId) obj.requestId = requestId;
      ws.send(JSON.stringify(obj));
    }

    // AJOUT (Phase 2 — modularisation du dispatch WS, terminée) : toutes les
    // actions ont un handler dans CATEGORY_HANDLERS (voir sa construction
    // plus haut, et chaque <categorie>-ws-handlers.js pour le détail par
    // action) — server.js n'est plus qu'un point de composition/bootstrap
    // pour ce dispatch, plus une seule action n'y est traitée directement.
    if (CATEGORY_HANDLERS.has(sanitized.action)) {
      await CATEGORY_HANDLERS.get(sanitized.action)(ws, sanitized, requestId, sendError);
      return;
    }

    // Phase 2 terminée : toutes les actions du dispatch WS sont couvertes
    // par CATEGORY_HANDLERS (voir sa construction plus haut, et chaque
    // <categorie>-ws-handlers.js pour le détail par action) — cette ligne
    // n'est jamais atteinte en fonctionnement normal, seulement si
    // CATEGORY_HANDLERS ne connaît pas l'action (garde-fou).
  });

  ws.on('close', () => {
    connRateLimiter.removeConnection(ws);
    log('Client WebSocket déconnecté');
  });
  ws.on('error', (err) => warn('WebSocket error: ' + err.message));
});

// ===========================================================================
// Audio pipeline
// ===========================================================================
// AJOUT (audit — fiabilité gratuite, sans modèle local) : un échec de
// transcription (hoquet réseau, 5xx transitoire côté Groq/Deepgram) faisait
// perdre le segment silencieusement — pas de nouvelle tentative, juste un
// avertissement console. Sur un service d'une heure, quelques secondes de
// coupure Wi-Fi pouvaient donc effacer une phrase entière. Deux tentatives
// avec un court délai suffisent à absorber un hoquet transitoire sans
// bloquer les segments suivants (l'appelant ne les attend pas — voir
// feedPcmChunk/handleAudioData dans audio-capture.js, purement fire-and-forget).
let consecutiveTranscriptionFailures = 0;
const TRANSCRIPTION_RETRY_DELAY_MS = 700;

async function transcribeWithRetry(segmentFile, contextHint, maxAttempts = 2) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // CORRECTIF (ASR découplé, §9-10) : passait auparavant par
      // groq.transcribeWithFallback() directement — désormais par
      // asr-engine.js, qui enveloppe EXACTEMENT le même appel par défaut
      // (ASR_PROVIDER=auto, aucun changement de comportement) tout en
      // permettant de forcer 'groq' ou 'deepgram' seul via cette variable.
      // { engine } renommé en { source } ici pour rester compatible avec le
      // reste de ce fichier (broadcast/log), sans devoir tout renommer.
      const asrResult = await asrEngine.transcribeSegment(segmentFile, contextHint);
      const result = {
        text: asrResult.text,
        confidence: asrResult.confidence,
        source: asrResult.engine,
      };
      if (consecutiveTranscriptionFailures > 0) {
        consecutiveTranscriptionFailures = 0;
        broadcast({ action: 'pipelineHealth', status: 'ok' });
        log('Transcription rétablie après ' + attempt + ' tentative(s)');
      }
      return result;
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        warn(
          `Transcription échouée (tentative ${attempt}/${maxAttempts}): ${err.message} — nouvel essai`
        );
        broadcast({ action: 'transcriptionRetrying', attempt, maxAttempts, error: err.message });
        await new Promise((resolve) => setTimeout(resolve, TRANSCRIPTION_RETRY_DELAY_MS));
      }
    }
  }
  consecutiveTranscriptionFailures++;
  broadcast({
    action: 'pipelineHealth',
    status: 'degraded',
    consecutiveFailures: consecutiveTranscriptionFailures,
  });
  throw lastErr;
}

function startPipeline() {
  // CORRECTIF (problème récurrent — transcription qui ne démarre jamais) :
  // compte les segments rejetés consécutivement pour silence (voir
  // audio-capture.js). Un silence isolé est normal (temps mort entre deux
  // prises de parole) ; ALERT_AFTER_CONSECUTIVE_SKIPS segments rejetés
  // d'affilée (~1 minute à 5s/segment) signale plutôt un micro trop
  // silencieux (mauvais périphérique, gain trop bas) — dans ce cas, sans
  // cette alerte, l'opérateur voit juste "en attente" indéfiniment sans
  // jamais savoir pourquoi.
  const ALERT_AFTER_CONSECUTIVE_SKIPS = 12;
  let consecutiveSkips = 0;
  let alertedForCurrentSilence = false;
  let silenceStartedAt = null; // horodatage réel du 1er skip de la série en cours

  // Étape 5c/5d — mémoire des partials de l'énoncé en cours (fenêtre glissante
  // N-3..N, bornée par l'identité du tracker d'énoncé) : une référence HIGH
  // n'est affichée sur un PARTIAL que si elle est déjà confirmée par un
  // partial précédent du même énoncé. Les partials Deepgram sont progressifs
  // mais PAS infaillibles : un numéro de verset peut y apparaître
  // temporairement faux (« verset 1 » corrigé en « verset 16 » au partial
  // suivant). Sinon (première occurrence) : candidateVerse spéculative +
  // préchargement du verset (cache Bible échauffé), sans affichage — le
  // partial suivant ou le final officiel confirmera. Cf. mission « la
  // référence n'est jamais affichée avant d'être CONFIRMÉE ».
  const PARTIAL_WINDOW_SIZE = 3;
  let lastPartialTracker = null;
  let recentPartialRefs = [];
  // AJOUT (Chantier 1 — latence chemin fusion) : même fenêtre de stabilité
  // pour le TEXTE BRUT des partials (pas seulement la référence complète).
  // Un fragment SANS référence complète (« 13 verset 4. », « 1 Corinthiens »)
  // n'est enfilé pour fusion que s'il est STABLE (2e occurrence identique du
  // même énoncé) — la fusion peut alors reconstruire la référence dès les
  // PARTIALS, sans attendre les finals (qui arrivent ~5-7s plus tard).
  let recentPartialTexts = [];
  function resetPartialWindow(tracker) {
    lastPartialTracker = tracker;
    recentPartialRefs = [];
    recentPartialTexts = [];
  }

  audioCapture.on({
    onAudioSegment: async (segmentFile, tracker) => {
      consecutiveSkips = 0;
      alertedForCurrentSilence = false;
      silenceStartedAt = null;
      try {
        // AJOUT (audit — boost transcription) : la fin du dernier segment déjà
        // transcrit sert d'indice de continuité pour Whisper (voir groq-wrapper.js).
        const contextHint = getRecentContext(300);
        const result = await transcribeWithRetry(segmentFile, contextHint);
        // AJOUT (latence, §14) : chemin segment/batch — un seul évènement
        // ASR (pas de partial), la marque 'asrFinal' couvre donc tout le
        // temps de transcription (Groq/Deepgram batch).
        if (tracker) tracker.mark('asrFinal');
        // Seuil rechargé à chaque segment (voir getTranscriptionConfidenceThreshold) :
        // ne bloque jamais quand la confiance est inconnue (ex. Groq sans
        // segments exploitables), ni sur une valeur malformée (NaN < seuil
        // vaut toujours false en JS), ni quand le seuil est désactivé (null).
        const confidenceThreshold = getTranscriptionConfidenceThreshold();
        const lowConfidence =
          confidenceThreshold !== null &&
          result &&
          typeof result.confidence === 'number' &&
          result.confidence < confidenceThreshold;
        if (lowConfidence) {
          warn(
            `Segment rejeté (confiance ${result.confidence.toFixed(2)} < seuil ${confidenceThreshold}) [${result.source}] : "${result.text.substring(0, 80)}"`
          );
          broadcast({
            action: 'transcriptRejected',
            text: result.text,
            confidence: result.confidence,
            threshold: confidenceThreshold,
          });
        } else if (result && result.text && result.text.trim()) {
          const confidenceNote =
            typeof result.confidence === 'number'
              ? ` (confiance ${result.confidence.toFixed(2)})`
              : '';
          log(`Transcription [${result.source}]${confidenceNote}: ${result.text.substring(0, 80)}`);
          broadcast({
            action: 'transcript',
            text: result.text,
            source: result.source,
            confidence: typeof result.confidence === 'number' ? result.confidence : null,
          });
          // AJOUT (sous-titres traduits en direct) : JAMAIS attendu (pas de
          // `await`) — voir le garde-fou en en-tête de caption-translator.js.
          // Un sous-titre traduit en retard/manqué est sans conséquence ;
          // retarder processTranscript() ci-dessous ne l'est pas.
          updateLiveCaption(result.text, null);
          if (sessionState.getTranslatedCaptionsEnabled()) {
            captionTranslator
              .translateCaption(result.text, sessionState.getCaptionTargetLang())
              .then((translated) => {
                if (translated) {
                  broadcast({ action: 'transcriptTranslation', text: translated });
                  updateLiveCaption(result.text, translated);
                }
              })
              .catch(() => {});
          }
          await enqueueTranscript(result.text, tracker);
          logLatencySummary(tracker);
        }
      } catch (err) {
        warn('Transcription error: ' + err.message);
        broadcast({ action: 'transcriptionError', error: err.message });
        sessionStore.recordPipelineError('transcription', err.message);
        if (plugins)
          plugins.emit('onError', { type: 'transcription', message: err.message }).catch(() => {});
      } finally {
        try {
          fs.unlinkSync(segmentFile);
        } catch (_) {}
      }
    },
    // AJOUT (Deepgram streaming, §7-13 du cahier des charges) : chemin
    // temps réel — audio-capture.js appelle ceci pour chaque évènement
    // 'Results' non-final reçu de Deepgram (voir deepgram-streaming.js).
    // Ne PAS lancer le pipeline complet (correction IA, fuzzy, sémantique —
    // couteux et instable sur un texte encore en train de se construire) :
    // seulement le court-circuit "référence explicite déjà connue"
    // (detector.detectExact, confidence 'high') — voir §13 "une référence
    // extrêmement claire peut être affichée avant le final si la confiance
    // est suffisante". processTranscript() re-fait ce même test en premier
    // en interne (redondant mais peu coûteux, pure regex) : le dédoublonnage
    // existant (sessionState.isDuplicateReference) absorbe proprement le cas
    // où le 'final' qui suit redit la même référence quelques centaines de
    // ms plus tard.
    onPartialTranscript: async (text, meta, tracker) => {
      broadcast({ action: 'transcriptPartial', text, confidence: meta && meta.confidence });
      if (tracker !== lastPartialTracker) {
        resetPartialWindow(tracker);
      }
      let fastMatch = null;
      try {
        const fastFr = detector.detectExact(text);
        const fastEn = detector.detectExactEn ? detector.detectExactEn(text) : null;
        if (fastFr && fastEn) {
          if (fastFr.confidence === 'high' && fastEn.confidence !== 'high') fastMatch = fastFr;
          else if (fastEn.confidence === 'high' && fastFr.confidence !== 'high') fastMatch = fastEn;
          else fastMatch = fastFr;
        } else {
          fastMatch = fastFr || fastEn;
        }
      } catch (_e) {
        // Texte partiel encore incomplet/malformé — pas une vraie erreur,
        // juste "pas encore de référence exploitable dans ce fragment".
      }
      if (fastMatch && fastMatch.confidence === 'high') {
        const refKey = `${fastMatch.book}:${fastMatch.chapter}:${fastMatch.verseStart || ''}`;
        const stable = recentPartialRefs.includes(refKey);
        recentPartialRefs.push(refKey);
        if (recentPartialRefs.length > PARTIAL_WINDOW_SIZE) recentPartialRefs.shift();
        if (stable) {
          log('Appel direct sur partial (référence explicite, stable) : ' + fastMatch.raw);
          await enqueueTranscript(text, tracker);
        } else {
          // Première occurrence : référence potentiellement en cours de
          // stabilisation — jamais affichée aveuglément (mission). On diffuse
          // une candidateVerse spéculative et on échauffe le cache Bible pour
          // que l'affichage (partial suivant ou final) soit quasi instantané.
          log('Référence partielle spéculative — attente de confirmation : ' + fastMatch.raw);
          broadcast({
            action: 'candidateVerse',
            reference: {
              book: fastMatch.book,
              chapter: fastMatch.chapter,
              verseStart: fastMatch.verseStart,
            },
            confidence: 'high',
            speculative: true,
            original: text,
          });
          bibleLookup
            .getVerseMultilang(
              {
                book: fastMatch.book,
                chapter: fastMatch.chapter,
                verseStart: fastMatch.verseStart,
                verseEnd: fastMatch.verseEnd,
              },
              sessionState.getDisplayLanguage()
            )
            .catch(() => {});
        }
      } else {
        // AJOUT (Chantier 1 — latence chemin fusion) : partial SANS référence
        // complète (pas de match HIGH). Ce fragment peut être une PARTIE d'un
        // énoncé que l'endpointing découpe (« 1 Corinthiens » puis « 13
        // verset 4. ») : enfilé SEULEMENT s'il est stable (2e occurrence
        // identique du même énoncé — les partials Deepgram sont progressifs
        // mais révisables, jamais d'action sur un texte volage), avec la
        // source 'partial-fragment'. processTranscript peut alors (a) le
        // mettre au buffer de fusion et reconstruire la référence dès les
        // partials, (b) s'il porte un nom de livre sans verset, le garder
        // sous la garde « chapitre seul ambigu » (candidateVerse + échauffage
        // du cache Bible), jamais affiché aveuglément.
        const stableText = recentPartialTexts.includes(text);
        recentPartialTexts.push(text);
        if (recentPartialTexts.length > PARTIAL_WINDOW_SIZE) recentPartialTexts.shift();
        if (stableText) {
          log('Fragment partiel stable enfilé pour fusion : ' + text.substring(0, 80));
          await enqueueTranscript(text, tracker, { source: 'partial-fragment' });
        }
      }
    },
    // AJOUT (Deepgram streaming) : évènement 'Results' final — chemin
    // AUTORITAIRE, équivalent au segment WAV classique mais sans jamais
    // avoir attendu la fin d'un fichier complet. Toujours passé par le
    // pipeline complet (correction/fuzzy/sémantique), qui rattrape tout ce
    // que le court-circuit sur partial ci-dessus aurait pu manquer.
    onFinalTranscript: async (text, meta, tracker) => {
      if (!text || !text.trim()) return;
      log(
        `Transcription [deepgram-streaming]${typeof meta?.confidence === 'number' ? ` (confiance ${meta.confidence.toFixed(2)})` : ''}: ${text.substring(0, 80)}`
      );
      broadcast({
        action: 'transcript',
        text,
        source: 'deepgram-streaming',
        confidence: typeof meta?.confidence === 'number' ? meta.confidence : null,
      });
      updateLiveCaption(text, null);
      if (sessionState.getTranslatedCaptionsEnabled()) {
        captionTranslator
          .translateCaption(text, sessionState.getCaptionTargetLang())
          .then((translated) => {
            if (translated) {
              broadcast({ action: 'transcriptTranslation', text: translated });
              updateLiveCaption(text, translated);
            }
          })
          .catch(() => {});
      }
      await enqueueTranscript(text, tracker, {
        source: meta?.finalizedBy === 'local-vad-silence' ? 'local-vad-silence' : 'deepgram-final',
      });
      logLatencySummary(tracker);
    },
    // AJOUT (Deepgram streaming) : la session temps réel est tombée — juste
    // visible côté opérateur, le repli lui-même est déjà entièrement géré
    // par audio-capture.js (reprise automatique du pipeline segment/Groq).
    onAsrFallback: (info) => {
      warn(
        'ASR streaming Deepgram indisponible — repli sur le pipeline segment/Groq : ' + info.reason
      );
      broadcast({
        action: 'asrFallback',
        reason: info.reason,
        message: 'Connexion temps réel Deepgram perdue — bascule sur le pipeline classique (Groq).',
      });
    },
    // AJOUT (A.1 — gain micro) : relaie les diagnostics de niveau audio du
    // worker vers le dashboard pour le vumètre et l'assistant de calibrage.
    onAudioDiagnostics: (info) => {
      broadcast({ action: 'audioDiagnostics', ...info });
    },
    onSegmentSkipped: (info) => {
      consecutiveSkips++;
      if (consecutiveSkips === 1) silenceStartedAt = Date.now();
      if (consecutiveSkips >= ALERT_AFTER_CONSECUTIVE_SKIPS && !alertedForCurrentSilence) {
        alertedForCurrentSilence = true;
        // CORRECTIF (2026-08-08) : `consecutiveSkips * 5000` supposait une
        // segmentation fixe à 5s (déjà fausse avant : segmentDuration vaut
        // 4000ms, et depuis le VAD streaming les segments n'ont plus une
        // durée fixe du tout) — remplacé par un horodatage réel.
        const elapsedS = silenceStartedAt
          ? Math.round((Date.now() - silenceStartedAt) / 1000)
          : '?';
        // CORRECTIF (2026-08-08 — diagnostic concret au lieu de générique) :
        // affiche le niveau le plus fort réellement capté (maxRms) et le
        // bruit ambiant appris à côté du seuil statique, pour distinguer
        // "vraiment aucun son" de "de la voix, mais sous les deux seuils" —
        // voir audio-capture.js flushSegment() pour le détail du calcul.
        const levelDetail =
          typeof info.maxRms === 'number'
            ? ` — pic capté ${info.maxRms.toFixed(4)}, seuil statique ${info.threshold}, ` +
              `seuil adaptatif ${info.adaptiveThreshold.toFixed(4)} (bruit ambiant appris ${info.noiseFloor.toFixed(4)})`
            : ` (niveau micro sous le seuil ${info.threshold})`;
        const message = `Aucune voix détectée depuis ~${elapsedS}s${levelDetail} — vérifiez le périphérique sélectionné et son gain.`;
        warn('Silence prolongé : ' + message);
        broadcast({ action: 'audioSilenceWarning', message, ...info });
        sessionStore.recordPipelineError('audio-silence', message);
      }
    },
    onError: (err) => {
      warn('Audio capture error: ' + err.message);
      broadcast({ action: 'audioError', error: err.message });
      sessionStore.recordPipelineError('audio', err.message);
    },
  });

  audioCapture.startBrowserCapture({ silenceThreshold: MIC_SILENCE_THRESHOLD });

  if (parentPort) {
    parentPort.postMessage({ type: 'audio-pipeline-ready' });
  }

  log(`Pipeline démarré sur ws://localhost:${SERVER_PORT}`);
  if (aiLoadErrors.length > 0) {
    log('⚠ ' + aiLoadErrors.length + ' AI feature(s) in limited mode (see logs above)');
  }
}

// ===========================================================================
// Worker IPC
// ===========================================================================
if (parentPort) {
  parentPort.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'shutdown') {
      log('Shutdown requested by main process');
      audioCapture.stopRecording();
      stopAmbientMoodLoop();
      wss.clients.forEach((ws) => ws.close());
      wss.close();
      connRateLimiter.stopCleanup();
      sessionStore.close();
      closeChurchAgent();
      if (parentPort) parentPort.postMessage({ type: 'status', status: 'stopped' });
      const finish = () => process.exit(0);
      if (plugins) {
        plugins
          .shutdown()
          .catch(() => {})
          .finally(finish);
        setTimeout(finish, 2000).unref?.();
      } else {
        finish();
      }
      return;
    }

    if (msg.type === 'theme-changed') {
      broadcast({ action: 'applyTheme', ...msg.css });
      return;
    }

    if (msg.type === 'obs-gate-changed') {
      sessionState.setObsGate(msg.open, msg.reason || '');
      log(`OBS gate: ${msg.open ? 'OPEN' : 'CLOSED'} (${sessionState.getObsGate().reason})`);
      return;
    }

    // AJOUT (Partie 3.1 — reconnexion automatique) : une coupure OBS en
    // plein culte ne doit jamais être silencieuse — diffusée telle quelle
    // au dashboard (voir action-registry.js, dashboard/ws-dispatch.js).
    if (msg.type === 'obs-connection-status') {
      log(`OBS connexion : ${msg.status} (${msg.reason || ''})`);
      broadcast({ action: 'obsConnectionStatus', status: msg.status, reason: msg.reason || '' });
      return;
    }

    if (msg.type === 'audio-pcm-chunk') {
      audioCapture.feedPcmChunk(Buffer.from(msg.buffer));
      return;
    }

    if (msg.type === 'hotkey-action') {
      handleHotkeyAction(msg.action);
      return;
    }
  });

  parentPort.postMessage({ type: 'status', status: 'running' });

  // AJOUT (mémoire — polish) : perf-monitor.js (main.js) n'échantillonnait
  // que le process principal Electron — le pipeline audio/ASR/Bible réel
  // tourne ici, dans ce worker, resté invisible côté dashboard sur un
  // culte de plusieurs heures. Même cadence que main.js (PERF_PUSH_MS =
  // 2000ms) pour rester cohérent avec l'échantillon déjà affiché.
  const workerMemTimer = setInterval(() => {
    const mem = process.memoryUsage();
    parentPort.postMessage({
      type: 'worker-mem',
      rssMB: Math.round((mem.rss / 1024 / 1024) * 10) / 10,
      heapUsedMB: Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10,
      externalMB: Math.round((mem.external / 1024 / 1024) * 10) / 10,
    });
  }, 2000);
  workerMemTimer.unref();
}

// ===========================================================================
// Bible lookup cache directory
// ===========================================================================
try {
  bibleLookup.setCacheDir(USER_DATA_DIR);
} catch (err) {
  warn('Failed to set Bible cache dir: ' + err.message);
}

// AJOUT (cahier des charges — Point 1B, base biblique hors-ligne) :
// idempotent (downloadFullBible() vérifie isAvailable() en premier, voir
// bible-offline-cache.js) — sans effet si déjà téléchargée, donc sans
// risque à appeler sans condition à chaque démarrage. Volontairement
// fire-and-forget (.catch, pas d'await) : un téléchargement de ~1189
// chapitres ne doit jamais retarder le démarrage du pipeline en direct.
// CORRECTIF (Chantier 0 — crash libuv à l'arrêt des tests) : sur Windows
// (Node ≥22), process.exit() pendant que les fetch() undici du
// téléchargement sont encore en vol déclenche un abort libuv
// ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)",
// src\win\async.c) — reproduit dans ~20 % des arrêts rapides. Les tests
// qui démarrent server.js puis sortent vite (process.exit) peuvent donc
// crasher leur process. CHURCHOVERLAY_SKIP_BIBLE_DOWNLOAD=1 permet aux
// tests de désactiver ce téléchargement sans effet sur la production.
try {
  bibleOfflineCache.setUserDataDir(USER_DATA_DIR);
  if (process.env.CHURCHOVERLAY_SKIP_BIBLE_DOWNLOAD !== '1') {
    bibleOfflineCache
      .downloadFullBible()
      .catch((err) => warn('Offline Bible download failed: ' + err.message));
    // AJOUT (Chantier 0 — cause réelle du crash libuv à l'arrêt) : un
    // téléchargement en vol au moment où le process se termine laisse des
    // fetch() undici ouverts et provoque une assertion libuv sur Windows
    // ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)") dans ~20 %
    // des arrêts rapides. On aborde ces fetch proprement à la sortie
    // (SIGINT/SIGTERM/exit) — l'env var CHURCHOVERLAY_SKIP_BIBLE_DOWNLOAD=1
    // reste nécessaire pour les TESTS qui s'arrêtent volontairement en
    // pleine session (process.exit immédiat, abort async trop tardif).
    const abortOfflineDownload = () => bibleOfflineCache.abortDownload();
    process.once('SIGINT', abortOfflineDownload);
    process.once('SIGTERM', abortOfflineDownload);
    process.once('exit', abortOfflineDownload);
  }
} catch (err) {
  warn('Failed to init offline Bible cache: ' + err.message);
}

try {
  sermonArchive.setUserDataDir(USER_DATA_DIR);
} catch (err) {
  warn('Failed to set sermon archive dir: ' + err.message);
}

try {
  mediaLibrary.setUserDataDir(USER_DATA_DIR);
  // AJOUT (audit fonctionnel — boutons "Media Cue" sans média correspondant) :
  // voir seedDefaultBackgrounds() dans media-library.js — idempotent, sans
  // effet après le tout premier démarrage.
  mediaLibrary.seedDefaultBackgrounds();
} catch (err) {
  warn('Failed to set media library dir: ' + err.message);
}

try {
  sceneStore.setUserDataDir(USER_DATA_DIR);
} catch (err) {
  warn('Failed to set scene store dir: ' + err.message);
}

try {
  rundownStore.setUserDataDir(USER_DATA_DIR);
} catch (err) {
  warn('Failed to set rundown store dir: ' + err.message);
}

try {
  ipCameraStore.setUserDataDir(USER_DATA_DIR);
} catch (err) {
  warn('Failed to set IP camera store dir: ' + err.message);
}

try {
  brandingStore.setUserDataDir(USER_DATA_DIR);
} catch (err) {
  warn('Failed to set branding store dir: ' + err.message);
}

try {
  dashboardBrandingStore.setUserDataDir(USER_DATA_DIR);
} catch (err) {
  warn('Failed to set dashboard branding store dir: ' + err.message);
}

try {
  songLibrary.setUserDataDir(USER_DATA_DIR);
} catch (err) {
  warn('Failed to set song library dir: ' + err.message);
}

// ===========================================================================
// Session store (persistance SQLite — voir session-store.js)
// ===========================================================================
sessionStore.init(USER_DATA_DIR, { onError: warn });

try {
  churchAgent = createChurchOverlayAgent({
    userDataDir: USER_DATA_DIR,
    services: {
      bibleLookup,
      detector,
      songLibrary,
      mediaLibrary,
      sceneStore,
      sessionState,
      broadcast,
    },
  });
  log('Agent IA chargé');
} catch (err) {
  warn('Agent IA indisponible : ' + err.message);
}

// ===========================================================================
// Startup
// ===========================================================================
configValidator
  .validateSystemConfig()
  .then(configValidator.displayValidationResults)
  .catch((err) => warn('config-validator: ' + err.message));

startPipeline();
startAmbientMoodLoop();

process.on('SIGTERM', () => {
  log('SIGTERM received');
  audioCapture.stopRecording();
  stopAmbientMoodLoop();
  wss.close();
  connRateLimiter.stopCleanup();
  sessionStore.close();
  closeChurchAgent();
  if (plugins) plugins.shutdown().catch(() => {});
  process.exit(0);
});

process.on('SIGINT', () => {
  log('SIGINT received');
  audioCapture.stopRecording();
  // AJOUT (audit production, cette session) : même écart que celui corrigé
  // au round 8 pour connRateLimiter juste en dessous, mais sur
  // stopAmbientMoodLoop() — inconnu du round 8 (la boucle d'ambiance
  // n'existait pas encore côté origin/main à ce moment-là). Même
  // raisonnement : sans impact fonctionnel réel (timer unref()é), mais
  // gardé symétrique avec SIGTERM par cohérence.
  stopAmbientMoodLoop();
  wss.close();
  // CORRECTIF (audit round 8) : le handler SIGTERM juste au-dessus arrête
  // connRateLimiter (voir round 7), mais ce handler SIGINT — le chemin pris
  // par un simple Ctrl+C en lancement manuel (`node server.js` / `npm run
  // server-only`) — avait été oublié. Sans réel impact fonctionnel puisque
  // le timer est unref()é par défaut, mais incohérent avec l'arrêt
  // "propre" documenté au round 7 ; corrigé pour rester symétrique avec
  // SIGTERM.
  connRateLimiter.stopCleanup();
  sessionStore.close();
  closeChurchAgent();
  if (plugins) plugins.shutdown().catch(() => {});
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  warn('Uncaught exception (arrêt du serveur): ' + ((err && err.stack) || err.message));
  try {
    audioCapture.cleanupTempFiles({ force: true });
  } catch (_) {}
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const message = (reason && reason.stack) || (reason && reason.message) || String(reason);
  warn('Unhandled promise rejection (arrêt du serveur): ' + message);
  try {
    audioCapture.cleanupTempFiles({ force: true });
  } catch (_) {}
  process.exit(1);
});

// AJOUT (tests uniquement — voir test/test-ws-backpressure.js) : ce fichier
// s'exécute comme un script (worker_thread entry point ou `node server.js`
// direct), jamais require()'d pour sa valeur de retour en production — ce
// module.exports n'a donc aucun effet sur main.js/le worker réel. Il existe
// uniquement pour donner aux tests un accès en LECTURE au vrai `wss` déjà
// utilisé partout ci-dessus (mêmes clients, même bufferedAmount réel) —
// impossible à observer autrement depuis l'extérieur : un test qui se
// contente de connecter un vrai client WebSocket ne voit que SON PROPRE
// bufferedAmount (toujours ~0, il n'envoie presque rien), jamais celui que
// le SERVEUR accumule en essayant de lui envoyer des messages qu'il ne lit
// plus (voir la logique de backpressure de broadcast() plus haut). Même
// principe que deepgramStreaming.setWsFactoryForTesting() : un point
// d'injection/observation explicite pour les tests, sans changer le
// comportement réel.
module.exports = { wss };
