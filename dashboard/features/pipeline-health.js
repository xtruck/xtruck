/**
 * dashboard/features/pipeline-health.js — bannières d'état du pipeline
 * (erreur worker, échecs de transcription consécutifs), copie des
 * liens overlay/habillage caméra pour OBS, et redémarrage manuel du
 * pipeline.
 * Extrait de dashboard/legacy-core.js (chantier de modularisation).
 */
import { state } from '../state.js';
import { showToast } from '../utils.js';

// AJOUT (Confidence Rail — idée créative, brief produit) : lu par
// confidence-rail.js pour composer son message unique prioritaire — reste
// privé à ce module (pipelineAlertActive), jamais un second état dupliqué
// ailleurs, voir le même principe pour getArmedCueId()/getCurrentLive() dans
// airlock-preview.js.
let pipelineAlertActive = false;
export function isPipelineAlertActive() {
  return pipelineAlertActive;
}

// --- Bannière d'erreur pipeline (voir CORRECTIF plus haut dans le HTML) ---
export function setPipelineAlert(payload) {
  const banner = document.getElementById('pipelineAlertBanner');
  const icon = document.getElementById('pipelineAlertIcon');
  const msg = document.getElementById('pipelineAlertMessage');
  if (!banner || !msg) return;

  if (!payload || payload.clear) {
    banner.style.display = 'none';
    banner.classList.remove('pipeline-banner--error', 'pipeline-banner--warning');
    pipelineAlertActive = false;
    return;
  }

  const isError = (payload.severity || 'warning') === 'error';
  banner.classList.toggle('pipeline-banner--error', isError);
  banner.classList.toggle('pipeline-banner--warning', !isError);
  banner.style.display = 'flex';
  if (icon) icon.textContent = isError ? '⛔' : '⚠️';
  msg.textContent = payload.message || 'Le pipeline a rencontré un problème.';
  pipelineAlertActive = true;
}

if (window.churchOverlay && window.churchOverlay.onPipelineAlert) {
  window.churchOverlay.onPipelineAlert(setPipelineAlert);
}

// AJOUT (audit — état de repli visible, session parallèle) : bannière
// distincte de pipelineAlertBanner ci-dessus (qui couvre le crash-loop du
// worker) — celle-ci se résorbe automatiquement dès qu'une transcription
// réussit (voir action 'pipelineHealth'), sans bouton de redémarrage : la
// retry est déjà automatique côté serveur (voir transcribeWithRetry() dans
// server.js). Palette alignée sur setPipelineAlert ci-dessus.
export function setTranscriptionHealth(payload) {
  const banner = document.getElementById('transcriptionHealthBanner');
  const icon = document.getElementById('transcriptionHealthIcon');
  const msg = document.getElementById('transcriptionHealthMessage');
  if (!banner || !msg) return;

  if (!payload || payload.status === 'ok') {
    banner.style.display = 'none';
    banner.classList.remove('pipeline-banner--error', 'pipeline-banner--warning');
    setOfflineManualBanner(false);
    offlineBannerAcknowledged = false; // rétabli — une prochaine coupure devra réalerter.
    return;
  }

  const isDegraded = payload.status === 'degraded';
  banner.classList.toggle('pipeline-banner--error', isDegraded);
  banner.classList.toggle('pipeline-banner--warning', !isDegraded);
  banner.style.display = 'flex';
  if (icon) icon.textContent = isDegraded ? '⛔' : '⚠️';
  msg.textContent = isDegraded
    ? `Transcription en difficulté (${payload.consecutiveFailures || 1} échec(s) d'affilée) — nouvelle tentative automatique en cours.`
    : `Nouvelle tentative de transcription (${payload.attempt}/${payload.maxAttempts})...`;

  if (isDegraded && (payload.consecutiveFailures || 0) >= OFFLINE_BANNER_THRESHOLD) {
    setOfflineManualBanner(true);
  }
}

// AJOUT (audit — bannière "hors ligne / mode manuel") : un échec isolé (une
// seule paire de tentatives, voir transcribeWithRetry() dans server.js) se
// résorbe déjà tout seul via la retry automatique et le bandeau discret
// ci-dessus — pas de quoi interrompre l'opérateur. À partir de
// OFFLINE_BANNER_THRESHOLD échecs CONSÉCUTIFS (~un par segment audio, voir
// startPipeline() côté serveur), c'est le signe d'une vraie coupure réseau
// (Groq/Deepgram injoignables), pas un hoquet : voir dashboard.html pour le
// marquage de la bannière elle-même.
const OFFLINE_BANNER_THRESHOLD = 3;
// Une fois l'opérateur passé en mode manuel depuis CETTE bannière (voir
// event-bindings.js), inutile de continuer à le relancer pour la même
// coupure en cours — il a déjà agi. Se réarme au prochain statut 'ok'
// ci-dessus (nouvelle coupure = nouvelle alerte).
let offlineBannerAcknowledged = false;

function setOfflineManualBanner(visible) {
  const banner = document.getElementById('offlineManualModeBanner');
  if (!banner) return;
  banner.style.display = visible && !offlineBannerAcknowledged ? 'flex' : 'none';
}

export function acknowledgeOfflineManualBanner() {
  offlineBannerAcknowledged = true;
  setOfflineManualBanner(false);
}
window.acknowledgeOfflineManualBanner = acknowledgeOfflineManualBanner;

// AJOUT (audit fonctionnel — statut IA en mode dégradé invisible) : server.js
// envoie déjà aiLoadErrors (messages lisibles, un par module IA en repli —
// voir ai-modules-loader.js) dans CHAQUE message 'init' (voir
// dashboard/ws-dispatch.js, case 'init'), jamais lu côté tableau de bord
// avant ce correctif. Prend seulement aiLoadErrors : ces messages nomment
// déjà le module concerné (ex. "SemanticDetector: ..."), donc relire aussi
// aiFeatures (booléens) n'ajouterait qu'un second calcul redondant, jamais
// affiché. Dismissible (demande explicite) via dismissAiDegradedBanner()
// ci-dessous — pas de drapeau "masqué" à maintenir : setAiDegradedStatus()
// n'est appelée qu'une fois par connexion (case 'init'), donc fermer la
// bannière puis se reconnecter (le seul moment où elle pourrait
// réapparaître) redemande légitimement l'attention de l'opérateur si le
// problème persiste toujours.
// AJOUT (audit — bannière IA jamais mise à jour par les échecs d'EXÉCUTION) :
// setAiDegradedStatus() ne reflétait que l'instantané de démarrage
// (aiLoadErrors, un message 'init' par connexion) — un module qui échoue en
// PLEIN CULTE (ex. semanticDetector rate-limited par Groq, voir
// server.js#wireAiModuleErrorBroadcast et son diffuseur 'aiModuleError',
// déjà lu ci-dessous côté toast/activité mais jamais côté bannière) ne
// touchait jamais #aiDegradedBanner — seul un toast throttlé (30s) et une
// ligne d'activité le signalaient, tous deux éphémères. runtimeAiErrors
// fusionne maintenant les deux sources dans la même bannière persistante.
let startupAiLoadErrors = [];
const runtimeAiErrors = new Map(); // module -> dernier message d'échec d'exécution
let aiDegradedBannerDismissed = false;

function renderAiDegradedBanner() {
  const banner = document.getElementById('aiDegradedBanner');
  const msg = document.getElementById('aiDegradedMessage');
  if (!banner || !msg) return;

  const messages = [
    ...startupAiLoadErrors,
    ...Array.from(runtimeAiErrors, ([moduleName, message]) => `${moduleName} : ${message}`),
  ];

  if (messages.length === 0) {
    banner.style.display = 'none';
    aiDegradedBannerDismissed = false;
    return;
  }

  msg.textContent =
    messages.length === 1
      ? `Fonctionnalité IA en mode limité : ${messages[0]}`
      : `${messages.length} fonctionnalités IA en mode limité : ${messages.join(' · ')}`;
  if (!aiDegradedBannerDismissed) banner.style.display = 'flex';
}

export function setAiDegradedStatus(aiLoadErrors) {
  startupAiLoadErrors = Array.isArray(aiLoadErrors) ? aiLoadErrors : [];
  aiDegradedBannerDismissed = false;
  renderAiDegradedBanner();
}

// AJOUT (audit) : appelé depuis ws-dispatch.js, case 'aiModuleError' — un
// message IDENTIQUE au précédent pour ce module (ex. rate-limited répété à
// chaque énoncé pendant tout un culte) ne rouvre PAS une bannière déjà
// fermée par l'opérateur, sinon elle serait de facto non-fermable tant que
// la limite de débit persiste. Un module NOUVEAU ou un message qui change
// (ex. passage de "rate-limited" à une vraie erreur API) redemande
// légitimement l'attention, même après fermeture.
export function recordAiModuleError(moduleName, message) {
  const isNewOrChanged = runtimeAiErrors.get(moduleName) !== message;
  runtimeAiErrors.set(moduleName, message);
  if (isNewOrChanged) aiDegradedBannerDismissed = false;
  renderAiDegradedBanner();
}

export function dismissAiDegradedBanner() {
  aiDegradedBannerDismissed = true;
  const banner = document.getElementById('aiDegradedBanner');
  if (banner) banner.style.display = 'none';
}
window.dismissAiDegradedBanner = dismissAiDegradedBanner;

// Au chargement, on récupère aussi l'état courant (utile si l'alerte a
// été émise avant que le tableau de bord ait fini de charger).
if (window.churchOverlay && window.churchOverlay.getStatus) {
  window.churchOverlay
    .getStatus()
    .then((s) => {
      if (s && s.status === 'error') {
        setPipelineAlert({
          severity: 'error',
          message:
            'Le pipeline audio est arrêté après plusieurs erreurs. Cliquez sur "Redémarrer le pipeline".',
        });
      }
      if (s && s.overlayUrl) applyOverlayUrl(s.overlayUrl);
      if (s && s.brandingOverlayUrl) applyBrandingOverlayUrl(s.brandingOverlayUrl);
    })
    .catch(() => {});
}

// CORRECTIF (audit — "je ne vois plus le lien à coller dans OBS") :
// main.js calcule déjà overlayUrl (avec le jeton WS_VIEWER_TOKEN requis
// depuis que l'authentification WebSocket est générée automatiquement à
// chaque démarrage) et le pousse via l'évènement IPC 'status-update' —
// preload.js exposait déjà onStatusUpdate(), mais dashboard.js ne
// l'écoutait jamais. Résultat : ce lien n'était affiché NULLE PART dans
// l'interface, y compris l'aperçu iframe de l'onglet "Overlay" (chargé
// sans jeton, donc lui-même incapable de se connecter au serveur).
export function applyOverlayUrl(url) {
  if (!url || url === state.overlayUrl) return;
  state.overlayUrl = url;
  const input = document.getElementById('overlayUrlInput');
  if (input) input.value = url;
  const frame = document.getElementById('overlayFrame');
  if (frame && !frame.dataset.loadedWithToken) {
    frame.src = url;
    frame.dataset.loadedWithToken = '1';
  }
}

export function copyOverlayUrl() {
  if (!state.overlayUrl) {
    showToast('Lien overlay pas encore disponible — attendez que le pipeline démarre.', 'error');
    return;
  }
  navigator.clipboard
    .writeText(state.overlayUrl)
    .then(() => {
      showToast(
        "Lien copié — collez-le dans OBS comme URL d'une Source Navigateur (Browser Source)",
        'success'
      );
    })
    .catch(() => {
      showToast(
        'Copie automatique impossible — sélectionnez le champ et copiez manuellement.',
        'error'
      );
    });
}

// AJOUT (habillage caméra) : même mécanisme que applyOverlayUrl() ci-dessus,
// pour le lien de branding-overlay.html (Source Navigateur OBS séparée, à
// empiler au-dessus de la caméra).
export function applyBrandingOverlayUrl(url) {
  if (!url || url === state.brandingOverlayUrl) return;
  state.brandingOverlayUrl = url;
  const input = document.getElementById('brandingOverlayUrlInput');
  if (input) input.value = url;
}

export function copyBrandingOverlayUrl() {
  if (!state.brandingOverlayUrl) {
    showToast('Lien pas encore disponible — attendez que le pipeline démarre.', 'error');
    return;
  }
  navigator.clipboard
    .writeText(state.brandingOverlayUrl)
    .then(() => {
      showToast(
        'Lien copié — collez-le dans OBS comme Source Navigateur, au-dessus de la caméra',
        'success'
      );
    })
    .catch(() => {
      showToast(
        'Copie automatique impossible — sélectionnez le champ et copiez manuellement.',
        'error'
      );
    });
}

// AJOUT (§7.1.5 — promouvoir l'existant sous-exploité) : companion.html/
// stage-display.html/announcement-loop.html existaient, fonctionnaient et
// étaient testés, mais leur lien n'était affiché NULLE PART dans
// l'interface — exactement le défaut déjà corrigé pour overlay.html/
// branding-overlay.html ci-dessus. Même mécanisme (apply = mémorise + pousse
// dans le champ, copy = presse-papiers + toast), factorisé ici plutôt que
// triplé : ces 3 pages n'ont pas d'iframe à recharger (contrairement à
// overlay.html), donc pas besoin de la logique dataset.loadedWithToken.
function makeNetworkUrlHandlers(stateKey, inputId, copyHintText) {
  return {
    apply(url) {
      if (!url || url === state[stateKey]) return;
      state[stateKey] = url;
      const input = document.getElementById(inputId);
      if (input) input.value = url;
    },
    copy() {
      if (!state[stateKey]) {
        showToast('Lien pas encore disponible — attendez que le pipeline démarre.', 'error');
        return;
      }
      navigator.clipboard
        .writeText(state[stateKey])
        .then(() => showToast(copyHintText, 'success'))
        .catch(() =>
          showToast(
            'Copie automatique impossible — sélectionnez le champ et copiez manuellement.',
            'error'
          )
        );
    },
  };
}

const companionUrlHandlers = makeNetworkUrlHandlers(
  'companionUrl',
  'companionUrlInput',
  "Lien copié — ouvrez-le sur le téléphone/tablette d'un membre de l'assemblée (même réseau Wi-Fi)"
);
export const applyCompanionUrl = companionUrlHandlers.apply;
export const copyCompanionUrl = companionUrlHandlers.copy;

const stageDisplayUrlHandlers = makeNetworkUrlHandlers(
  'stageDisplayUrl',
  'stageDisplayUrlInput',
  'Lien copié — ouvrez-le sur un écran/tablette dédié au conducteur de louange'
);
export const applyStageDisplayUrl = stageDisplayUrlHandlers.apply;
export const copyStageDisplayUrl = stageDisplayUrlHandlers.copy;

const announcementLoopUrlHandlers = makeNetworkUrlHandlers(
  'announcementLoopUrl',
  'announcementLoopUrlInput',
  "Lien copié — ouvrez-le sur l'écran d'accueil/du hall pour un diaporama d'annonces en boucle"
);
export const applyAnnouncementLoopUrl = announcementLoopUrlHandlers.apply;
export const copyAnnouncementLoopUrl = announcementLoopUrlHandlers.copy;

if (window.churchOverlay && window.churchOverlay.onStatusUpdate) {
  window.churchOverlay.onStatusUpdate((payload) => {
    if (payload && payload.overlayUrl) applyOverlayUrl(payload.overlayUrl);
    if (payload && payload.brandingOverlayUrl) applyBrandingOverlayUrl(payload.brandingOverlayUrl);
    if (payload && payload.companionUrl) applyCompanionUrl(payload.companionUrl);
    if (payload && payload.stageDisplayUrl) applyStageDisplayUrl(payload.stageDisplayUrl);
    if (payload && payload.announcementLoopUrl) {
      applyAnnouncementLoopUrl(payload.announcementLoopUrl);
    }
    // CORRECTIF (audit — Offline/reconnect status, priorité #9) : ce canal
    // porte payload.status ('starting'/'running'/'error'/'stopped', voir
    // serverStatus dans main.js) depuis le tout début, mais rien ici ne le
    // lisait jamais — un commentaire plus bas dans ce fichier affirmait même
    // à tort que pipelineAlertBanner "couvre déjà le crash-loop du worker",
    // alors que ce cas précis (worker.on('exit') dans main.js : port déjà
    // utilisé, ou trop de crashes rapprochés -> pipeline arrêté) ne déclenche
    // JAMAIS de message pipeline-alert — seulement ce status-update ignoré.
    // Résultat réel : un opérateur ne voyait alors QUE "Déconnecté —
    // reconnexion en cours" indéfiniment (le symptôme WS), jamais la vraie
    // raison ni le bouton "Redémarrer" déjà prêt dans la bannière existante.
    // 'stopped' n'alerte pas : main.js ne le pose que pour un arrêt VOLONTAIRE
    // (voir wasIntentional dans main.js), pas un signal de panne. Se résorbe
    // tout seul via le clear existant (pipeline-alert{clear:true}, envoyé
    // par main.js dès que le worker redémarré signale 'running').
    if (payload && payload.status === 'error') {
      setPipelineAlert({
        severity: 'error',
        message:
          "Le pipeline s'est arrêté suite à une erreur (voir les journaux dans l'icône de la zone de notification) — cliquez sur Redémarrer.",
      });
    }
  });
}

let restartInFlight = false;
export async function restartPipeline() {
  if (restartInFlight || !window.churchOverlay || !window.churchOverlay.requestRestart) return;
  restartInFlight = true;
  showToast('Redémarrage du pipeline en cours...', 'info');
  try {
    await window.churchOverlay.requestRestart();
    showToast('Pipeline redémarré', 'success');
  } catch (e) {
    showToast('Échec du redémarrage : ' + (e && e.message ? e.message : e), 'error');
  } finally {
    restartInFlight = false;
  }
}

window.copyOverlayUrl = copyOverlayUrl;
window.copyBrandingOverlayUrl = copyBrandingOverlayUrl;
window.copyCompanionUrl = copyCompanionUrl;
window.copyStageDisplayUrl = copyStageDisplayUrl;
window.copyAnnouncementLoopUrl = copyAnnouncementLoopUrl;
window.restartPipeline = restartPipeline;
