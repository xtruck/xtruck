/**
 * dashboard/ws-dispatch.js — hub de dispatch des messages WebSocket entrants
 * (handleMessage), le routeur central "action reçue -> module feature qui la
 * rend".
 *
 * Extrait de dashboard/legacy-core.js (chantier de modularisation, dernier
 * lot). C'est la pièce la plus interconnectée du tableau de bord (elle
 * importe depuis quasiment tous les modules feature) mais la plus mécanique
 * à extraire une fois ceux-ci stabilisés : chaque branche du switch se
 * contente d'appeler une fonction déjà exportée ailleurs. IMPORT CIRCULAIRE
 * assumé et sûr avec state.js (voir son commentaire d'en-tête) : `state`
 * n'est utilisé ici qu'à l'intérieur des branches du switch, jamais évalué
 * au chargement du module.
 */
import { showToast, addActivity, escapeHtmlDashboard } from './utils.js';
import { state } from './state.js';
import {
  displayVerse,
  hideVerseDisplay,
  addTranscript,
  showCandidateVerse,
  clearCandidateNotices,
  formatReferenceLabel,
  updateDashboard,
} from './features/verse-session-display.js';
import { renderMoodPicker, setActiveMoodButton } from './features/mood-theme.js';
import { renderSongLibrary } from './features/song-library.js';
import { renderOfflineBibleStatus } from './features/offline-bible.js';
import {
  renderAiEnricherOutput,
  renderSessionStats,
  renderHighlightsExport,
  updateSermonModeBadge,
  renderSermonQaResult,
  requestAutoTranslation,
  renderPreServiceCheckResult,
  renderAiStats,
  renderClipExportStarted,
  renderClipExportProgress,
  renderClipExportComplete,
} from './features/preservice-ai.js';
import {
  renderMediaLibrary,
  renderMediaWall,
  markMediaOnScreen,
  clearMediaOnScreen,
  renderTriggerPhraseTestResult,
  renderMediaGroupsPanel,
} from './features/media-library.js';
import { renderSceneStudioGallery, handlePptxImportResult } from './features/scene-studio.js';
import { handleServiceExportResult, handleServiceImportResult } from './features/service-export.js';
import { renderRundown, applyRundownActiveCue } from './features/rundown.js';
import { renderNetworkStatus } from './features/network-settings.js';
import { renderIpCameras, showCameraPairingQr } from './features/ip-cameras.js';
import { renderBranding } from './features/branding.js';
import {
  setTranscriptionHealth,
  setAiDegradedStatus,
  recordAiModuleError,
} from './features/pipeline-health.js';
import { loadOverlayThemeSelector } from './features/overlay-theme-selector.js';
import {
  renderBibleTopics,
  renderBibleSearchResults,
  renderBibleSearchError,
} from './features/bible-search.js';
import {
  setReadingModeActive,
  setReadingPosition,
  clearReadingPosition,
} from './features/reading-mode.js';
import {
  renderTranslationPicker,
  updateActiveTranslationButton,
  renderSecondaryTranslationOptions,
  updateSecondaryTranslationSelect,
} from './features/translation-picker.js';
import { applyDashboardBranding } from './features/dashboard-branding.js';
import { updateAudioVumeter } from './features/audio-vumeter.js';
import { renderAgentEvent } from './features/agent.js';
import {
  updateTrustModeButtons,
  showPendingVerseBanner,
  hidePendingVerseBanner,
} from './features/trust-mode.js';
import { setCurrentLive, clearCurrentLive } from './features/airlock-preview.js';

export function handleMessage(message) {
  switch (message.action) {
    case 'agentEvent':
      renderAgentEvent(message);
      break;
    // AJOUT (sélecteur de version biblique / identité de marque du tableau
    // de bord) : 'init', le tout premier message envoyé par le serveur à
    // chaque connexion (voir server.js), n'avait jusqu'ici AUCUN case ici —
    // porte pourtant translations, plugins, history, theme, branding,
    // dashboardBranding, defaultMedia... Ce correctif consomme translations
    // ET dashboardBranding (portée volontairement limitée à ce que ces deux
    // lots construisent) ; reconstruire l'état complet du tableau de bord
    // au chargement depuis le reste de ce message reste un chantier
    // séparé, plus large, pas entrepris ici.
    case 'init':
      renderTranslationPicker(message.translations);
      renderSecondaryTranslationOptions(message.translations);
      if (message.secondaryTranslation) {
        updateSecondaryTranslationSelect(
          message.secondaryTranslation.lang,
          message.secondaryTranslation.code
        );
      }
      applyDashboardBranding(message.dashboardBranding);
      updateTrustModeButtons(message.trustMode || 'auto');
      // CORRECTIF (état obsolète après reconnexion) : le serveur renvoie un
      // 'init' complet à CHAQUE connexion, reconnexion comprise (server.js >
      // wss.on('connection')), mais ce case n'en lisait que les 4 champs
      // ci-dessus. Les bibliothèques (médias/scènes/chants/feuille de route…)
      // s'en sortent car state.js les redemande explicitement à chaque
      // onopen ; la langue et les bascules d'affichage, elles, n'ont AUCUNE
      // requête équivalente — leur seule source est ce message. Résultat en
      // production : coupure réseau / redémarrage serveur / veille du
      // portable pendant le culte, un autre poste change la langue ou coupe
      // les sous-titres entre-temps, et ce tableau de bord se reconnecte en
      // affichant encore l'ancien état — l'opérateur croit piloter ce qu'il
      // voit alors que l'overlay fait autre chose. On réapplique donc ici
      // EXACTEMENT les mêmes fonctions que les diffusions live appellent
      // (applyLanguageButtons/applyAccessibilityToggle/…), jamais une
      // seconde implémentation qui pourrait diverger.
      //
      // Sans toast, volontairement : ces helpers sont partagés avec les case
      // de diffusion ci-dessous, qui gardent leur toast (un changement fait
      // par quelqu'un d'autre mérite d'être signalé). Ici ce n'est qu'une
      // resynchronisation — 6 toasts empilés à chaque reconnexion masqueraient
      // les vrais messages en plein direct.
      applyLanguageButtons(message.language || 'fr');
      applyAccessibilityToggle(message.highContrast);
      applyCaptionsToggle(message.captions);
      applyTranslatedCaptionsToggle(message.translatedCaptions, message.captionTargetLang);
      applyTestPatternToggle(message.testPattern);
      applyBackgroundPattern(message.backgroundPattern || 'none');
      // AJOUT (rôle opérateur/spectateur) : le serveur distingue déjà les deux
      // rôles (server.js > determineClientRole, OPERATOR_ACTIONS) et refuse
      // côté serveur les actions d'opérateur à un client 'viewer' — mais rien
      // côté tableau de bord ne lisait ce champ. On se contente de le mémoriser
      // pour que les modules puissent s'y référer ; masquer/désactiver les
      // commandes selon le rôle est une fonctionnalité à part entière (bien
      // plus large que ce correctif de reconnexion) et n'est pas faite ici.
      state.yourRole = message.yourRole || null;
      // AJOUT (audit fonctionnel — statut IA en mode dégradé invisible) :
      // aiLoadErrors est déjà présent dans CHAQUE message 'init' (voir
      // server.js), jamais lu ici avant ce correctif — voir
      // setAiDegradedStatus() dans pipeline-health.js.
      setAiDegradedStatus(message.aiLoadErrors);
      break;
    // CORRECTIF (audit — coche de thème obsolète sur une 2e fenêtre tableau
    // de bord) : overlay-theme-selector.js ne se ré-affichait qu'après un
    // appel `selectOverlayTheme()` dans SA PROPRE fenêtre — un second
    // tableau de bord ouvert (ou un changement de thème par ambiance/
    // commande vocale, voir server.js) ne le rafraîchissait jamais, laissant
    // une coche "✓" sur un thème qui n'est plus réellement actif.
    // loadOverlayThemeSelector() re-questionne l'état réel (IPC
    // list-themes/get-active-theme) — peu coûteux, appelé aussi pour les
    // applyTheme d'ambiance qui ne changent pas le thème actif : sans
    // conséquence, juste un re-rendu identique.
    case 'applyTheme':
      loadOverlayThemeSelector();
      break;
    case 'translationChanged':
      updateActiveTranslationButton(message.language, message.code);
      showToast(`Version biblique changée (${message.language}).`, 'success');
      break;
    case 'secondaryTranslationChanged':
      updateSecondaryTranslationSelect(message.lang, message.code);
      break;
    case 'dashboardBrandingUpdate':
      applyDashboardBranding(message.branding);
      break;
    case 'showVerse':
      // AJOUT (Étape 5 — candidateVerse) : un vrai verset arrive — la
      // confirmation attendue est là, on efface tout bandeau candidat
      // (fuzzy + spéculatif) pour ne pas le laisser traîner 8s à côté du
      // verset affiché.
      clearCandidateNotices();
      // AJOUT (Partie 2 — mode confiance) : un verset confirmé (ou en mode
      // auto) vient d'être affiché — le bandeau de confirmation, s'il était
      // visible, n'a plus lieu d'être.
      hidePendingVerseBanner();
      // AJOUT (Partie 2.3 — état "à l'écran" du mur média) : l'overlay
      // n'affiche qu'une seule chose à la fois.
      clearMediaOnScreen();
      // AJOUT (frontend — mode lecture "pro") : le serveur diffuse la
      // position courante dans le chapitre à chaque avancement (voir
      // server.js > readingModePosition) — affichée dans la carte mode
      // lecture, sans que le dashboard ait à compter lui-même.
      if (message.readingModePos) setReadingPosition(message.readingModePos);
      displayVerse(message);
      // AJOUT (Airlock Preview) : la colonne "en direct" reflète TOUJOURS ce
      // que l'overlay affiche réellement, quelle que soit sa source (repère
      // de feuille de route, détection vocale, saisie manuelle) — voir
      // airlock-preview.js.
      setCurrentLive({ type: 'verse', reference: message.reference, text: message.text });
      state.totalVerses++;
      updateDashboard();
      addActivity(`Verset affiché : ${message.reference}`, 'success');
      showToast(`Verset : ${message.reference}`, 'success');
      // AJOUT : traduction live automatique si le toggle est activé —
      // chaque nouveau verset déclenche translateText sans action manuelle.
      if (state.autoTranslateEnabled && message.text) {
        requestAutoTranslation(message);
      }
      // Auto-trigger cross-references when a verse is shown
      if (message.reference && state && state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(
          JSON.stringify({
            action: 'getCrossReferences',
            reference: message.reference,
            text: message.text || '',
          })
        );
      }
      break;
    case 'hideVerse':
      hideVerseDisplay();
      clearCandidateNotices();
      clearCurrentLive();
      addActivity('Verset masqué', 'info');
      break;
    case 'transcript':
      addTranscript(message);
      break;
    case 'transcriptRejected':
      // AJOUT (fix — versets affichés sans être prononcés) : jusqu'ici un
      // segment de faible confiance (bruit/écho mal transcrit) était rejeté
      // en silence côté serveur — l'opérateur ne voyait ni le texte
      // halluciné, ni pourquoi rien ne s'affichait. Visible dans le flux
      // d'activité pour comprendre un micro trop bruyant sans deviner.
      // Porté depuis dashboard/legacy-core.js (fusion du 2026-08-10) — voir
      // server.js pour l'émission (action broadcastée quand confidence <
      // seuil configuré, jamais de valeur inventée ici).
      addActivity(
        `Segment ignoré (confiance ${Math.round((message.confidence || 0) * 100)}% < ${Math.round((message.threshold || 0) * 100)}%) : "${message.text.substring(0, 60)}"`,
        'warning'
      );
      break;
    case 'candidateVerse':
      showCandidateVerse(message);
      // CORRECTIF (frontend) : message.reference est un OBJET
      // ({ book, chapter, verseStart }) — l'afficher tel quel dans le flux
      // d'activité produisait "[object Object]".
      addActivity(`Verset candidat : ${formatReferenceLabel(message.reference)}`, 'warning');
      break;
    case 'error':
      addActivity(`Erreur : ${message.error}`, 'error');
      showToast(`Erreur : ${message.error}`, 'error');
      break;
    case 'dedupSuppressed':
      addActivity(`Doublon supprimé : ${message.ref} (${message.reason || 'same-ref'})`, 'info');
      break;
    case 'transcriptionError':
      addActivity(`Transcription indisponible : ${message.error}`, 'error');
      // CORRECTIF (audit — message d'erreur générique inutile) : ce toast
      // affichait toujours "vérifier la connexion internet" quelle que soit
      // la vraie cause (clé API invalide, quota dépassé, clé absente...),
      // alors que le message réel (message.error) était déjà disponible —
      // juste jamais montré ailleurs que dans le flux d'activité, moins
      // visible. Affiche désormais la vraie raison.
      showToast(`Transcription en échec : ${message.error || 'raison inconnue'}`, 'error');
      break;
    case 'audioError':
      addActivity(`Capture audio interrompue : ${message.error}`, 'error');
      showToast(`Micro/audio en échec — vérifier la capture`, 'error');
      break;
    case 'audioSilenceWarning':
      addActivity(message.message, 'warning');
      showToast(`⚠️ ${message.message}`, 'error');
      break;
    // AJOUT (A.2 — visibilité des échecs IA) : jusqu'ici un échec d'appel
    // (Groq indisponible, timeout…) dans corrector/semanticDetector/
    // themeGenerator ne remontait que dans les logs serveur — invisible
    // depuis le dashboard, pendant tout un culte s'il le fallait. Toast
    // throttlé par module (30s) pour ne pas noyer l'opérateur si un même
    // module échoue à chaque segment ; l'activité, elle, reste non
    // throttlée (déjà un flux tolérant au volume).
    case 'aiModuleError':
      addActivity(`Module IA en échec (${message.module}) : ${message.message}`, 'warning');
      if (shouldToastAiModuleError(message.module)) {
        showToast(`⚠️ Module IA « ${message.module} » en échec — repli automatique actif`, 'error');
      }
      // CORRECTIF (audit — bannière IA jamais mise à jour par un échec
      // d'exécution) : le toast/l'activité ci-dessus sont éphémères — un
      // opérateur qui ne regarde pas l'écran au bon moment (ex.
      // semanticDetector rate-limited pendant une longue prédication) n'en
      // gardait aucune trace persistante. Même bannière que setAiDegradedStatus
      // (case 'init'), voir recordAiModuleError() dans pipeline-health.js.
      recordAiModuleError(message.module, message.message);
      break;
    // AJOUT (Partie 3.1 — reconnexion automatique OBS) : une coupure OBS en
    // plein culte ne doit jamais être silencieuse — visible dans le
    // panneau OBS (RÉGIE) et dans l'activité, avec un toast à chaque
    // changement d'état (peu fréquent par nature, pas besoin de throttle
    // comme pour aiModuleError ci-dessus).
    case 'obsConnectionStatus':
      updateObsConnectionStatus(message.status, message.reason);
      break;
    // AJOUT (Partie 2 — mode confiance)
    case 'trustModeChanged':
      updateTrustModeButtons(message.trustMode);
      addActivity(`Mode confiance : ${message.trustMode}`, 'info');
      break;
    case 'pendingVerseConfirmation':
      showPendingVerseBanner(message);
      addActivity(`Verset en attente de confirmation : ${message.reference}`, 'info');
      break;
    case 'pendingVerseDismissed':
      hidePendingVerseBanner();
      addActivity(`Verset en attente ignoré/remplacé : ${message.reference}`, 'info');
      break;
    // AJOUT (A.1 — gain micro) : diagnostics de niveau audio temps réel
    // pour le vumètre du dashboard.
    case 'audioDiagnostics':
      updateAudioVumeter(message);
      updateListeningBar(message);
      // AJOUT (A.1 — assistant de calibrage) : no-op si l'assistant de
      // démarrage n'est pas ouvert (startup-wizard.js expose ce point
      // d'entrée via window, voir son commentaire d'en-tête).
      if (window.updateWizardMicCalibration) window.updateWizardMicCalibration(message);
      break;
    case 'preServiceCheckResult':
      renderPreServiceCheckResult(message);
      break;
    case 'networkStatus':
      renderNetworkStatus(message);
      break;
    // AJOUT (audit round 6) : réponses des modules ai-enricher.js,
    // jusqu'ici sans destination côté dashboard (les WS envoyaient bien
    // ces actions, mais rien n'écoutait la réponse).
    case 'sermonTheme': {
      updateSermonModeBadge(message);
      // Update themes card in PRÉPARATION
      const themesEl = document.getElementById('themesList');
      if (themesEl && message.theme) {
        themesEl.innerHTML =
          '<div class="stat-row"><span class="stat-label">Thème</span><span class="stat-value">' +
          escapeHtmlDashboard(message.theme) +
          '</span></div>' +
          (message.keywords
            ? '<div class="stat-row"><span class="stat-label">Mots-clés</span><span class="stat-value" style="font-size:0.8rem">' +
              escapeHtmlDashboard(message.keywords.join(', ')) +
              '</span></div>'
            : '');
      }
      if (!message.silent) {
        renderAiEnricherOutput(
          message.theme
            ? `Thème détecté : ${message.theme}${message.keywords ? ' — mots-clés : ' + message.keywords.join(', ') : ''}`
            : 'Aucun thème identifiable pour le moment (transcription encore trop courte).'
        );
      }
      break;
    }
    case 'liveSummary':
      renderLiveSummary(message);
      break;
    case 'aiStats':
      renderAiStats(message);
      break;
    case 'crossReferences':
      renderCrossReferences(message);
      break;
    case 'textTranslated':
      // Le broadcast vers l'overlay (action showTranslation) est fait
      // directement par le serveur quand autoBroadcast est vrai (voir
      // requestAutoTranslation) — ici on ne fait qu'afficher côté dashboard.
      if (!message.autoBroadcast) {
        renderAiEnricherOutput(`Traduction (${message.targetLang}) : ${message.translation}`);
      }
      break;
    case 'sessionStats':
      renderSessionStats(message);
      break;
    case 'highlightsExported':
      renderHighlightsExport(message);
      break;
    case 'clipExportStarted':
      renderClipExportStarted();
      break;
    case 'clipExportProgress':
      renderClipExportProgress(message);
      break;
    case 'clipExportComplete':
      renderClipExportComplete(message);
      break;
    case 'postServiceRecap': {
      state.lastPostServiceRecap = message.recap || null;
      // Show the dedicated recap card
      const recapCard = document.getElementById('postServiceRecapCard');
      const recapContent = document.getElementById('postServiceRecapContent');
      if (recapCard) recapCard.style.display = '';
      if (recapContent && message.recap) {
        const r = message.recap;
        recapContent.innerHTML =
          (r.title ? '<strong>' + escapeHtmlDashboard(r.title) + '</strong><br>' : '') +
          (r.keyPoints && r.keyPoints.length
            ? '<br><strong>Points clés :</strong> ' +
              r.keyPoints.map(escapeHtmlDashboard).join(', ')
            : '') +
          (r.application
            ? '<br><strong>Application :</strong> ' + escapeHtmlDashboard(r.application)
            : '') +
          (r.memoryVerse
            ? '<br><strong>Verset à retenir :</strong> ' + escapeHtmlDashboard(r.memoryVerse)
            : '');
        recapContent.style.color = 'var(--text-main)';
      } else if (recapContent) {
        recapContent.textContent = 'Récap indisponible.';
      }
      // Also keep the old output for compatibility
      renderAiEnricherOutput(
        message.recap
          ? `${message.recap.title || 'Récap du culte'} — Points clés : ${(message.recap.keyPoints || []).join(', ')}. ` +
              `Application : ${message.recap.application || '—'}. Verset à retenir : ${message.recap.memoryVerse || '—'}.`
          : 'Récap indisponible.'
      );
      break;
    }
    // AJOUT (innovation frontend — sélecteur d'ambiances) : le serveur
    // envoyait déjà ces deux réponses (server.js: 'moodsList' sur
    // getMoods, 'themeApplied' sur setMoodTheme) mais aucun cas ne les
    // traitait ici — le générateur de thèmes IA restait invisible et
    // inutilisable depuis le tableau de bord.
    case 'moodsList':
      renderMoodPicker(message.moods || []);
      break;
    case 'themeApplied':
      setActiveMoodButton(message.mood);
      addActivity(`Ambiance changée : ${message.themeName || message.mood}`, 'info');
      showToast(`Ambiance : ${message.themeName || message.mood}`, 'success');
      break;
    // AJOUT (transparence détection IA) : diffusé par server.js juste avant
    // le 'showVerse' correspondant quand c'est le détecteur sémantique
    // (LLM), pas la détection littérale, qui a trouvé la référence. Posé
    // ici, consommé par displayVerse() dans verse-session-display.js (voir
    // son commentaire pour la fenêtre de validité de 5s).
    case 'semanticDetected':
      state.pendingSemanticDetection = { ...message, receivedAt: Date.now() };
      break;
    // AJOUT (recherche de versets par thème) : searchBible/getTopics
    // (bible-semantic-search.js) fonctionnaient déjà côté serveur, sans
    // aucune UI côté tableau de bord — voir bible-search.js pour le
    // rappel important sur ce que "par thème" veut dire ici (pas de
    // recherche IA/sémantique réelle aujourd'hui).
    case 'topicsList':
      renderBibleTopics(message.topics || []);
      break;
    case 'searchResults':
      renderBibleSearchResults(message);
      break;
    case 'searchError':
      renderBibleSearchError(message);
      break;
    // AJOUT (mode lecture — bouton manuel) : bascule l'état actif/inactif
    // de l'UI (boutons Suivant/Précédent) — voir reading-mode.js. Le
    // verset lui-même arrive séparément via 'showVerse' (déjà géré
    // ci-dessus), readingMode.onVerseAdvance() le diffuse côté serveur à
    // chaque avancée.
    case 'readingStarted':
      setReadingModeActive(true);
      showToast('Mode lecture démarré.', 'success');
      break;
    case 'readingStopped':
      setReadingModeActive(false);
      clearReadingPosition();
      showToast('Mode lecture arrêté.', 'info');
      break;
    // AJOUT (fiabilité — synchronisation multi-opérateur) : setHighContrast/
    // setCaptions/setTranslatedCaptions/setTestPattern/setBackgroundPattern
    // (préservice-ai.js/mood-theme.js) diffusaient déjà une confirmation
    // côté serveur (broadcast, donc envoyée à TOUS les tableaux de bord
    // connectés), mais rien ici ne l'écoutait — un opérateur cliquant "sous-
    // titres" n'avait aucune confirmation que ça avait bien pris côté
    // serveur, et un DEUXIÈME tableau de bord ouvert restait à l'ancien
    // état sans jamais l'apprendre. Chaque case resynchronise la case à
    // cocher/le bouton correspondant (pas seulement un toast) pour que ça
    // reste vrai même sur un tableau de bord qui n'a pas cliqué lui-même.
    case 'accessibilityMode':
      applyAccessibilityToggle(message.highContrast);
      showToast(
        message.highContrast ? 'Mode grand contraste activé.' : 'Mode grand contraste désactivé.',
        'info'
      );
      break;
    case 'captionsMode':
      applyCaptionsToggle(message.captions);
      showToast(message.captions ? 'Sous-titres activés.' : 'Sous-titres désactivés.', 'info');
      break;
    case 'translatedCaptionsMode':
      applyTranslatedCaptionsToggle(message.enabled, message.targetLang);
      showToast(
        message.enabled
          ? `Sous-titres traduits activés (${message.targetLang}).`
          : 'Sous-titres traduits désactivés.',
        'info'
      );
      break;
    case 'testPatternMode':
      applyTestPatternToggle(message.enabled);
      showToast(message.enabled ? 'Motif de test activé.' : 'Motif de test désactivé.', 'info');
      break;
    case 'backgroundPatternMode':
      applyBackgroundPattern(message.pattern);
      showToast(
        `Motif de fond : ${BACKGROUND_PATTERN_LABELS[message.pattern] || message.pattern}`,
        'success'
      );
      break;
    // AJOUT (audit — état de repli visible, session parallèle) : émises par
    // transcribeWithRetry() côté serveur (server.js) — un échec de
    // transcription tente désormais un nouvel essai automatique avant
    // d'abandonner. Distinct du case 'transcriptionError' déjà présent
    // ci-dessus (qui gère l'échec final) : ceci couvre les tentatives
    // intermédiaires et l'état "dégradé" persistant.
    case 'transcriptionRetrying':
      setTranscriptionHealth({
        status: 'retrying',
        attempt: message.attempt,
        maxAttempts: message.maxAttempts,
      });
      break;
    case 'pipelineHealth':
      setTranscriptionHealth(message);
      if (message.status === 'ok') {
        addActivity('Transcription rétablie', 'success');
      }
      break;
    // AJOUT (audit — mémoire des cultes, session parallèle) : réponse à
    // getArchiveMatches (voir sermon-archive.js — recherche locale par
    // mots-clés, pas d'IA impliquée ici).
    case 'archiveMatches':
      renderAiEnricherOutput(
        message.results && message.results.length
          ? `Cultes correspondants pour "${message.query}" : ` +
              message.results
                .map((r) => {
                  const date = new Date(r.date).toLocaleDateString('fr-FR', {
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric',
                  });
                  return `${r.theme || 'Sans titre'} (${date})`;
                })
                .join(' · ')
          : `Aucun culte archivé ne correspond à "${message.query}".`
      );
      break;
    // AJOUT (médiathèque — déclenchement vocal de photos/vidéos) : la liste
    // vit côté serveur, diffusée à tous les tableaux de bord ouverts après
    // chaque ajout/suppression pour rester synchronisée entre eux.
    case 'mediaLibraryUpdated':
      renderMediaLibrary(message.items);
      renderMediaWall(message.items);
      break;
    // AJOUT (Partie 2.3 — bouton "essayer")
    case 'triggerPhraseTestResult':
      renderTriggerPhraseTestResult(message);
      break;
    // AJOUT (Partie 2.3 — groupes nommés déclenchables à la voix)
    case 'mediaGroupsUpdated':
      renderMediaGroupsPanel(message.groups);
      break;
    // AJOUT (Partie 2.3 — Mur Média, collisions phonétiques dès l'import) :
    // non bloquant — le média est déjà ajouté (voir 'mediaLibraryUpdated'
    // juste avant celui-ci) — seulement un avertissement pour que
    // l'opérateur puisse reformuler une phrase déclencheuse AVANT le culte
    // plutôt que de découvrir la confusion en plein direct.
    case 'mediaTriggerCollisions':
      {
        const details = message.collisions
          .map(
            (c) =>
              `"${c.phrase}" ↔ "${c.withPhrase}" (${c.withLabel})${c.exact ? ' — IDENTIQUE' : ` — distance ${c.distance}`}`
          )
          .join(' ; ');
        addActivity(
          `⚠️ ${message.collisions.length} collision(s) phonétique(s) pour "${message.itemLabel}" : ${details}`,
          'warning'
        );
        showToast(
          `⚠️ "${message.itemLabel}" : ${message.collisions.length} phrase(s) déclencheuse(s) trop proche(s) d'un autre média/chant — voir l'activité`,
          'error'
        );
      }
      break;
    // AJOUT (studio de scènes) : même raisonnement que mediaLibraryUpdated
    // ci-dessus — la liste vit côté serveur, diffusée à tous les tableaux de
    // bord ouverts après chaque ajout/suppression/modification.
    case 'sceneLibraryUpdated':
      renderSceneStudioGallery(message.scenes);
      break;
    // AJOUT (Partie 7.1.1 — import PowerPoint) : réponse ciblée (pas un
    // broadcast) à importPptxSlides — sceneLibraryUpdated ci-dessus arrive
    // séparément et rafraîchit déjà la galerie ; ce message ne sert qu'à
    // afficher le résumé du résultat à l'opérateur qui a lancé l'import.
    case 'pptxImportResult':
      handlePptxImportResult(message);
      break;
    // AJOUT (Partie 7.1.2 — export du service portable) : même raisonnement
    // que pptxImportResult ci-dessus (réponse ciblée, pas un broadcast).
    case 'serviceExportResult':
      handleServiceExportResult(message);
      break;
    // AJOUT (Partie 7.1.2 — import du service portable) : même raisonnement
    // — les broadcasts mediaLibraryUpdated/sceneLibraryUpdated/
    // songLibraryUpdated/rundownUpdated arrivent séparément et rafraîchissent
    // déjà chaque panneau ; ce message ne sert qu'au résumé affiché à
    // l'opérateur qui a lancé l'import.
    case 'serviceImportResult':
      handleServiceImportResult(message);
      break;
    // AJOUT (chantier 4.3 — feuille de route/cue-list) : même raisonnement
    // que sceneLibraryUpdated ci-dessus (liste persistée côté serveur,
    // diffusée à tous les tableaux de bord ouverts). rundownActiveCue est
    // distinct : ne transporte QUE le pointeur "repère actif", pas la liste.
    case 'rundownUpdated':
      renderRundown(message);
      break;
    case 'rundownActiveCue':
      applyRundownActiveCue(message);
      break;
    // AJOUT (caméras de téléphone) : même raisonnement que mediaLibraryUpdated
    // ci-dessus — la liste vit côté serveur, diffusée à tous les tableaux de
    // bord ouverts après chaque ajout/suppression.
    case 'ipCamerasUpdated':
      renderIpCameras(message.items);
      break;
    // AJOUT (caméra téléphone par QR code) : réponse ponctuelle à
    // generateCameraPairing() — affiche le QR généré, voir showCameraPairingQr().
    case 'cameraPairingGenerated':
      showCameraPairingQr(message);
      break;
    // AJOUT (habillage caméra) : même raisonnement — diffusé à chaque
    // changement pour rester synchronisé entre plusieurs tableaux de bord.
    case 'brandingUpdate':
      renderBranding(message.branding);
      break;
    case 'showMedia':
      addActivity(
        `Média affiché : ${message.label}` +
          (message.detectedBy === 'voice-cue' ? ' (déclenché à la voix)' : ''),
        'info'
      );
      markMediaOnScreen(message.id);
      setCurrentLive({
        type: 'media',
        label: message.label,
        mediaType: message.mediaType,
        mediaUrl: message.mediaUrl,
      });
      break;
    case 'hideMedia':
      clearMediaOnScreen();
      clearCurrentLive();
      break;
    // AJOUT (Operator activity log — brief produit, priorité #10) : jusqu'ici
    // un média cassé sur l'overlay (repli automatique, voir Smart Fallback
    // Mode) ne laissait de trace que dans la console du projecteur, jamais
    // vu par l'opérateur pendant le culte — voir reportMediaLoadFailure()
    // dans overlay.js/media-ws-handlers.js.
    case 'mediaLoadFailureReported':
      addActivity(
        `Média introuvable/corrompu, repli automatique : « ${message.label || '(sans nom)'} »`,
        'error'
      );
      break;
    // AJOUT (studio de scènes) : même raisonnement que showMedia/hideMedia
    // ci-dessus.
    case 'showScene':
      addActivity(`Scène affichée : ${message.name}`, 'info');
      // AJOUT (Partie 2.3 — état "à l'écran" du mur média) : l'overlay
      // n'affiche qu'une seule chose à la fois — une scène qui s'affiche
      // remplace forcément un média qui l'était.
      clearMediaOnScreen();
      // AJOUT (Airlock Preview) : message porte déjà background/elements
      // résolus (resolveSceneMediaUrls() côté serveur) — passé tel quel à
      // renderSceneDom() par airlock-preview.js.
      setCurrentLive({ type: 'scene', label: message.name, scene: message });
      break;
    case 'hideScene':
      clearCurrentLive();
      break;
    // AJOUT (bibliothèque de chants) : même raisonnement que mediaLibraryUpdated.
    case 'songLibraryUpdated':
      renderSongLibrary(message.songs);
      break;
    // AJOUT (stage display) : messages opérateur -> écran scène uniquement,
    // rien à faire côté tableau de bord au-delà d'un accusé dans le journal
    // d'activité (le contenu réel s'affiche sur stage-display.html).
    case 'stageMessage':
      addActivity(`Message envoyé à l'écran scène : ${message.text}`, 'info');
      break;
    case 'stageMessageClear':
      break;
    // AJOUT (base biblique hors-ligne) : voir renderOfflineBibleStatus() plus bas.
    case 'offlineBibleStatus':
      renderOfflineBibleStatus(message);
      break;
    // AJOUT (cahier des charges — assistant sermons) : voir renderSermonQaResult().
    case 'sermonQuestionAnswered':
      renderSermonQaResult(message);
      break;
    // AJOUT : le serveur diffusait déjà languageChanged (déclenché par
    // une commande vocale "passe en bilingue", ou par un autre tableau
    // de bord connecté) mais rien n'écoutait ici — les boutons de langue
    // restaient figés sur FR même après un changement effectif.
    case 'languageChanged':
      applyLanguageButtons(message.language || 'fr');
      if (message.triggeredByVoice) {
        addActivity(`Langue changée par commande vocale : ${state.activeLanguage}`, 'info');
      }
      break;
  }
}

/* ============================================================================
   CORRECTIF (état obsolète après reconnexion) : ces six fonctions étaient
   auparavant écrites en ligne dans les case de diffusion ('languageChanged',
   'accessibilityMode', 'captionsMode', 'translatedCaptionsMode',
   'testPatternMode', 'backgroundPatternMode'). Extraites ici pour que le case
   'init' puisse réappliquer LE MÊME code à chaque (re)connexion : deux
   implémentations parallèles finiraient par diverger, et c'est justement une
   divergence silencieuse de ce genre (un id de case à cocher renommé d'un côté
   seulement) qui laisserait de nouveau l'opérateur devant un tableau de bord
   qui ment sur l'état réel de l'overlay, en plein culte.

   Elles ne font QUE mettre l'UI en cohérence : aucun toast, aucun envoi WS
   (sinon 'init' rediffuserait vers le serveur l'état qu'il vient d'en
   recevoir, et une reconnexion écraserait un changement fait ailleurs). Les
   toasts restent dans les case appelants.
   ============================================================================ */

function applyLanguageButtons(language) {
  state.activeLanguage = String(language).toUpperCase();
  document.querySelectorAll('.lang-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.lang === language);
  });
  updateDashboard();
}

function applyAccessibilityToggle(highContrast) {
  const cb = document.getElementById('highContrastToggle');
  if (cb) cb.checked = !!highContrast;
}

function applyCaptionsToggle(captions) {
  const cb = document.getElementById('captionsToggle');
  if (cb) cb.checked = !!captions;
}

function applyTranslatedCaptionsToggle(enabled, targetLang) {
  const cb = document.getElementById('translatedCaptionsToggle');
  if (cb) cb.checked = !!enabled;
  const langSelect = document.getElementById('captionTargetLangSelect');
  if (langSelect && targetLang) langSelect.value = targetLang;
}

function applyTestPatternToggle(enabled) {
  const cb = document.getElementById('testPatternToggle');
  if (cb) cb.checked = !!enabled;
}

const BACKGROUND_PATTERN_LABELS = {
  none: 'Aucun motif',
  dots: 'Points',
  grid: 'Grille',
  diagonal: 'Diagonales',
};

function applyBackgroundPattern(pattern) {
  document.querySelectorAll('#patternPicker .mood-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.id === `pattern-btn-${pattern}`);
  });
}

// AJOUT (A.2 — visibilité des échecs IA) : un seul toast par module IA
// toutes les 30s, pour ne pas noyer l'opérateur si Groq est indisponible
// pendant tout un culte (un échec par segment transcrit sinon).
const AI_MODULE_ERROR_TOAST_COOLDOWN_MS = 30000;
const aiModuleErrorLastToastAt = new Map();
function shouldToastAiModuleError(moduleName) {
  const now = Date.now();
  const last = aiModuleErrorLastToastAt.get(moduleName) || 0;
  if (now - last < AI_MODULE_ERROR_TOAST_COOLDOWN_MS) return false;
  aiModuleErrorLastToastAt.set(moduleName, now);
  return true;
}

// AJOUT (Partie 3.1 — assistant de connexion + reconnexion automatique
// OBS) : met à jour le panneau OBS (RÉGIE) à chaque changement d'état de
// connexion, y compris les tentatives de reconnexion après une coupure.
const OBS_STATUS_LABELS = {
  connected: { icon: '✅', label: (r) => r || 'Connecté à OBS Studio.' },
  disconnected: { icon: '❌', label: (r) => r || 'Connexion OBS perdue.' },
  reconnecting: { icon: '🔄', label: (r) => r || 'Reconnexion à OBS en cours…' },
  error: { icon: '❌', label: (r) => r || 'Échec de connexion à OBS.' },
};
function updateObsConnectionStatus(status, reason) {
  const style = OBS_STATUS_LABELS[status] || OBS_STATUS_LABELS.error;
  const text = `${style.icon} ${style.label(reason)}`;
  const statusEl = document.getElementById('obsStatus');
  if (statusEl) statusEl.textContent = text;
  addActivity(`OBS : ${text}`, status === 'connected' ? 'success' : 'warning');
  if (status !== 'connected') {
    showToast(text, 'error');
  }
}

// Listening bar — état audio compact en haut de l'espace Direct
function updateListeningBar(msg) {
  const dot = document.getElementById('listeningDot');
  const status = document.getElementById('listeningStatus');
  const level = document.getElementById('listeningLevel');
  const confidence = document.getElementById('listeningConfidence');
  const lang = document.getElementById('listeningLang');
  if (!dot) return;

  const rms = msg.rmsMean || 0;
  const clipping = msg.clippingRate || 0;
  const pct = Math.min(100, Math.round(rms * 300));

  level.style.width = pct + '%';
  level.style.background =
    clipping > 0.01 ? '#ef4444' : pct > 60 ? '#f59e0b' : pct > 15 ? '#22c55e' : '#6b7280';

  if (clipping > 0.01) {
    dot.style.background = '#ef4444';
    status.textContent = 'Écrêté';
    status.style.color = '#ef4444';
  } else if (pct > 15) {
    dot.style.background = '#22c55e';
    status.textContent = 'Écoute active';
    status.style.color = '#22c55e';
  } else {
    dot.style.background = '#6b7280';
    status.textContent = 'En attente…';
    status.style.color = 'var(--text-dim)';
  }

  if (confidence && msg.confidence != null) {
    confidence.textContent = Math.round(msg.confidence * 100) + '%';
  }
  if (lang && state && state.activeLanguage) {
    lang.textContent = state.activeLanguage;
  }
}

// Cross-references — affichées dans la carte dédiée PRÉPARATION
function renderCrossReferences(msg) {
  const el = document.getElementById('crossRefResults');
  const status = document.getElementById('crossRefStatus');
  if (!el) return;
  if (!msg.results || msg.results.length === 0) {
    el.innerHTML =
      '<div class="stat-row"><span class="stat-label">Aucune référence croisée pour ' +
      escapeHtmlDashboard(msg.reference || '') +
      '</span></div>';
    if (status) {
      status.textContent = '0';
      status.style.display = '';
    }
    return;
  }
  el.innerHTML = msg.results
    .map(
      (r) =>
        '<div class="stat-row"><span class="stat-label">' +
        escapeHtmlDashboard(r.ref || '') +
        '</span>' +
        '<span class="stat-value" style="font-size:0.75rem;color:var(--text-dim)">' +
        escapeHtmlDashboard(r.reason || '') +
        '</span></div>'
    )
    .join('');
  if (status) {
    status.textContent = msg.results.length;
    status.style.display = '';
  }
}

// Live summary — rolling summary dans la carte dédiée PRÉPARATION
function renderLiveSummary(msg) {
  const el = document.getElementById('liveSummaryContent');
  if (!el) return;
  if (msg.summary) {
    el.textContent = msg.summary;
    el.style.color = 'var(--text-main)';
  } else {
    el.textContent = 'Résumé indisponible pour le moment.';
    el.style.color = 'var(--text-dim)';
  }
}

// Exposition globale explicite (module ES, pas de globals implicites).
window.handleMessage = handleMessage;
