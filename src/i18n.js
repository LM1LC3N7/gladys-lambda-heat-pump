// -----------------------------------------------------------------------------
// Runtime texts (English and French): device and feature names, the codes of
// the controller (names from the manual), the status and the command errors.
// The language is the `language` option of the configuration.
// -----------------------------------------------------------------------------

export const word = (text, language) => (typeof text === 'string' ? text : text[language]);
const w = (en, fr) => ({ en, fr });

/** Device names, by kind; `n` from 1. */
export const DEVICE_NAMES = {
  system: () => w('Lambda heat pump – system', 'Pompe à chaleur Lambda – système'),
  hp: (n) => w(`Lambda heat pump ${n}`, `Pompe à chaleur Lambda ${n}`),
  dhw: (n) => w(`Lambda hot water tank ${n}`, `Ballon d'eau chaude Lambda ${n}`),
  buffer: (n) => w(`Lambda buffer tank ${n}`, `Ballon tampon Lambda ${n}`),
  hc: (n) => w(`Lambda heating circuit ${n}`, `Circuit de chauffage Lambda ${n}`),
};

export const FEATURE_NAMES = {
  'error-number': w('Error number', "Numéro d'erreur"),
  state: w('State', 'État'),
  'emanager-error-number': w(
    'Energy manager error number',
    "Numéro d'erreur du gestionnaire d'énergie",
  ),
  'emanager-state': w('Energy manager state', "État du gestionnaire d'énergie"),
  'temperature-outdoor-average': w(
    'Outdoor temperature (1 h average)',
    'Température extérieure (moyenne 1 h)',
  ),
  'temperature-outdoor-calculated': w(
    'Outdoor temperature of the heating curve',
    'Température extérieure de la courbe de chauffe',
  ),
  'power-consumption': w(
    'Power drawn by the heat pumps',
    'Puissance absorbée des pompes à chaleur',
  ),
  'power-setpoint': w('Power draw target (W)', 'Consigne de puissance absorbée (W)'),
  'error-state': w('Error state', "État d'erreur"),
  'operating-state': w('Operating state', 'État de fonctionnement'),
  'temperature-flow': w('Flow temperature', 'Température de départ'),
  'temperature-return': w('Return temperature', 'Température de retour'),
  'temperature-source-in': w('Source inlet temperature', "Température d'entrée de la source"),
  'temperature-source-out': w('Source outlet temperature', 'Température de sortie de la source'),
  'compressor-rating': w('Compressor rating (%)', 'Régime du compresseur (%)'),
  'heating-capacity': w('Heating output (kW)', 'Puissance de chauffe (kW)'),
  'inverter-power': w('Inverter power draw', "Puissance absorbée de l'onduleur"),
  cop: w('COP', 'COP'),
  booster: w('Electric heater relay', 'Relais de la résistance électrique'),
  'temperature-top': w('Temperature (top)', 'Température (haut)'),
  'temperature-bottom': w('Temperature (bottom)', 'Température (bas)'),
  'temperature-circulation': w('Circulation temperature', 'Température de bouclage'),
  'circulation-pump': w('Circulation pump', 'Pompe de bouclage'),
  setpoint: w('Hot water setpoint', "Consigne d'eau chaude"),
  'max-temperature': w('Maximum buffer temperature', 'Température maximale du tampon'),
  'temperature-room': w('Room temperature', 'Température ambiante'),
  mode: w('Operating mode (request)', 'Mode de fonctionnement (demande)'),
  'flow-setpoint': w('Calculated flow setpoint', 'Consigne de départ calculée'),
  offset: w('Heating curve offset (K)', 'Décalage de la courbe de chauffe (K)'),
  'room-setpoint': w('Room setpoint (heating)', 'Consigne ambiante (chauffage)'),
  'room-setpoint-cooling': w('Room setpoint (cooling)', 'Consigne ambiante (rafraîchissement)'),
};

/** The codes of the controller, by map (src/lambda.js `map`), from the manual. */
export const STATE_NAMES = {
  system: {
    0: w('Off', 'Arrêt'),
    1: w('Automatic', 'Automatique'),
    2: w('Manual', 'Manuel'),
    3: w('Fault', 'Défaut'),
  },
  emanager: {
    0: w('Off', 'Arrêt'),
    1: w('Automatic', 'Automatique'),
    2: w('Manual', 'Manuel'),
    3: w('Fault', 'Défaut'),
    4: w('Offline', 'Hors ligne'),
  },
  hpError: {
    0: w('No error', 'Aucune erreur'),
    1: w('Message', 'Message'),
    2: w('Warning', 'Avertissement'),
    3: w('Error', 'Erreur'),
    4: w('Fault', 'Défaut'),
  },
  hpState: {
    0: w('Initialisation', 'Initialisation'),
    1: w('Referencing', 'Référencement'),
    2: w('Lock time', 'Temps de blocage'),
    3: w('Ready', 'Prête'),
    4: w('Pump start', 'Démarrage de la pompe'),
    5: w('Compressor start', 'Démarrage du compresseur'),
    6: w('Pre-regulation', 'Pré-régulation'),
    7: w('Regulation', 'Régulation'),
    9: w('Cooling', 'Rafraîchissement'),
    10: w('Defrosting', 'Dégivrage'),
    20: w('Stop', 'Arrêt'),
    30: w('Fault', 'Défaut'),
    31: w('Error', 'Erreur'),
    40: w('Error reset', "Réinitialisation de l'erreur"),
  },
  hpOperating: {
    0: w('Standby', 'Veille'),
    1: w('Heating', 'Chauffage'),
    2: w('Hot water', 'Eau chaude'),
    3: w('Cooling', 'Rafraîchissement'),
    4: w('Circulating', 'Circulation'),
    5: w('Defrosting', 'Dégivrage'),
    6: w('Off', 'Arrêt'),
    7: w('Frost protection', 'Hors-gel'),
    8: w('Ready, frost protection', 'Prête, hors-gel'),
    10: w('Summer mode', 'Mode été'),
    11: w('Holiday mode', 'Mode vacances'),
    12: w('Error', 'Erreur'),
    13: w('Warning', 'Avertissement'),
    14: w('Message', 'Message'),
    15: w('Lock time', 'Temps de blocage'),
    16: w('Utility lock', 'Blocage du fournisseur'),
    17: w('Temperature lock', 'Blocage de température'),
    18: w('Software update', 'Mise à jour du logiciel'),
  },
  dhw: {
    0: w('Standby', 'Veille'),
    1: w('Heating', 'Chauffe'),
    2: w('Legionella program', 'Programme anti-légionelle'),
    3: w('Summer mode', 'Mode été'),
    4: w('Frost protection', 'Hors-gel'),
    5: w('Holiday mode', 'Mode vacances'),
    6: w('Paused by priority', 'Pause pour priorité'),
    7: w('Error', 'Erreur'),
    8: w('Off', 'Arrêt'),
    9: w('Forced hot water', 'Eau chaude forcée'),
    10: w('Run-on time', 'Temporisation'),
    11: w('Temperature lock', 'Blocage de température'),
    12: w('Standby, frost protection', 'Veille, hors-gel'),
  },
  buffer: {
    0: w('Standby', 'Veille'),
    1: w('Heating', 'Chauffe'),
    2: w('Cooling', 'Rafraîchissement'),
    3: w('Summer mode', 'Mode été'),
    4: w('Frost protection', 'Hors-gel'),
    5: w('Holiday mode', 'Mode vacances'),
    6: w('Paused by priority', 'Pause pour priorité'),
    7: w('Error', 'Erreur'),
    8: w('Off', 'Arrêt'),
    9: w('Standby, frost protection', 'Veille, hors-gel'),
  },
  hc: {
    0: w('Heating', 'Chauffage'),
    1: w('Reduced heating', 'Chauffage réduit'),
    2: w('Cooling', 'Rafraîchissement'),
    3: w('Screed drying', 'Séchage de chape'),
    4: w('Frost protection', 'Hors-gel'),
    5: w('Overtemperature fault', 'Défaut de surchauffe'),
    6: w('Error', 'Erreur'),
    7: w('Maintenance', 'Maintenance'),
    8: w('Holiday mode', 'Mode vacances'),
    9: w('Summer mode', 'Mode été'),
    10: w('Winter (cooling-only circuit)', 'Hiver (circuit de rafraîchissement seul)'),
    11: w('Paused by priority', 'Pause pour priorité'),
    12: w('Off', 'Arrêt'),
    13: w('Not released', 'Non autorisé'),
    14: w('Disabled by schedule', 'Désactivé par le programme'),
    15: w('Standby', 'Veille'),
    16: w('Standby heating', 'Veille chauffage'),
    17: w('Standby reduced', 'Veille réduit'),
    18: w('Standby cooling', 'Veille rafraîchissement'),
    19: w('Standby frost protection', 'Veille hors-gel'),
    20: w('Standby screed program', 'Veille programme de chape'),
  },
};

/** Heating circuit mode requests (register 5x06), by key (src/lambda.js HC_MODES). */
export const MODE_NAMES = {
  release: w('No request (heat pump setting)', 'Aucune demande (réglage de la PAC)'),
  off: w('Off', 'Arrêt'),
  manual: w('Manual', 'Manuel'),
  automatic: w('Automatic', 'Automatique'),
  'auto-heating': w('Automatic heating', 'Chauffage automatique'),
  'auto-cooling': w('Automatic cooling', 'Rafraîchissement automatique'),
  frost: w('Frost protection', 'Hors-gel'),
  summer: w('Summer mode', 'Mode été'),
  screed: w('Screed program', 'Programme de chape'),
};

export const codeText = (code) => w(`Code ${code}`, `Code ${code}`);
export const OFFLINE = w('Heat pump unreachable', 'Pompe à chaleur injoignable');

/** Command errors (what Gladys shows or logs). */
export const ERRORS = {
  readOnly: w('This feature is read only.', 'Cette fonctionnalité est en lecture seule.'),
  disabled: w(
    'Commands are disabled in the configuration ("Allow the commands").',
    'Les commandes sont désactivées dans la configuration (« Autoriser les commandes »).',
  ),
  badMode: w('Unknown mode.', 'Mode inconnu.'),
  badNumber: w('Not a number.', "Ce n'est pas un nombre."),
  badStep: (step) => w(`Steps of ${step} °C only.`, `Par pas de ${step} °C seulement.`),
  outOfRange: (min, max) =>
    w(`Allowed from ${min} to ${max} °C.`, `Autorisé de ${min} à ${max} °C.`),
  dhwCap: (cap) =>
    w(
      `Above the hot water ceiling of the configuration (${cap} °C).`,
      `Au-dessus du plafond d'eau chaude de la configuration (${cap} °C).`,
    ),
  stillRunning: w(
    'A command for this module is still running.',
    'Une commande pour ce module est encore en cours.',
  ),
  unknownDevice: w(
    'Unknown module (not in the configuration, or no controller address).',
    "Module inconnu (absent de la configuration, ou pas d'adresse du régulateur).",
  ),
  missingValue: w(
    'Nothing sent: the current value could not be read.',
    "Rien envoyé : la valeur actuelle n'a pas pu être lue.",
  ),
  unknownState: (reason) =>
    w(
      `Nothing sent: the current value could not be read (${reason}).`,
      `Rien envoyé : la valeur actuelle n'a pas pu être lue (${reason}).`,
    ),
  tooSlow: w(
    'Nothing sent: the heat pump did not answer in time.',
    "Rien envoyé : la pompe à chaleur n'a pas répondu à temps.",
  ),
  notSent: (reason) => w(`Nothing sent (${reason}).`, `Rien envoyé (${reason}).`),
  refused: (reason) =>
    w(`Refused by the heat pump (${reason}).`, `Refusé par la pompe à chaleur (${reason}).`),
  sentUnconfirmed: (reason) =>
    w(`Sent, without confirmation (${reason}).`, `Envoyé, sans confirmation (${reason}).`),
  notApplied: w(
    'Sent, not applied yet: the heat pump still reads the previous value.',
    'Envoyé, pas encore appliqué : la pompe à chaleur relit encore la valeur précédente.',
  ),
  readBack: (value) =>
    w(
      `Sent, but the heat pump reads back ${value}.`,
      `Envoyé, mais la pompe à chaleur relit ${value}.`,
    ),
  supersededByProtective: w(
    'Nothing sent: a stop or a minimum setpoint was asked for this module after the command.',
    'Rien envoyé : un arrêt ou une consigne minimale a été demandé pour ce module après la commande.',
  ),
  stopRunning: w(
    'Refused: a stop of this heating circuit is being sent.',
    "Refusé : un arrêt de ce circuit de chauffage est en cours d'envoi.",
  ),
  holdKept: w(
    'The stop is kept and written again every 20 s.',
    "L'arrêt est gardé et réécrit toutes les 20 s.",
  ),
  floorKept: w(
    'The floor setpoint will be written again by the next reads.',
    'La consigne plancher sera réécrite par les prochaines lectures.',
  ),
};

/** Why a held mode ended (French; the English is the key). */
const RELEASE_REASONS = {
  'address cleared': { fr: 'adresse effacée' },
  'another controller': { fr: 'autre régulateur' },
  'circuit removed from the configuration': { fr: 'circuit retiré de la configuration' },
  'device deleted': { fr: 'appareil supprimé' },
  'released from Gladys': { fr: 'libéré depuis Gladys' },
  'commands disabled': { fr: 'commandes désactivées' },
  'held for 24 h, the controller takes over': {
    fr: 'maintenu depuis 24 h, le régulateur reprend la main',
  },
  'mode changed elsewhere': { fr: 'mode changé ailleurs' },
};

/** The connection status of the configuration screen. */
export const T = {
  connecting: w('Connecting to the heat pump…', 'Connexion à la pompe à chaleur…'),
  noAddress: w(
    'Enter the IP address of the heat pump controller.',
    "Saisissez l'adresse IP du régulateur de la pompe à chaleur.",
  ),
  invalid: (typed) => w(`Invalid address: "${typed}".`, `Adresse invalide : « ${typed} ».`),
  configUnread: w(
    'The configuration could not be read from Gladys: trying again.',
    "La configuration n'a pas pu être lue depuis Gladys : nouvel essai.",
  ),
  unreachable: (address, reason, wait) =>
    w(
      `Heat pump ${address} unreachable (${reason}); next try in ${wait}.`,
      `Pompe à chaleur ${address} injoignable (${reason}) ; nouvel essai dans ${wait}.`,
    ),
  connected: (address, notes) =>
    w(
      [`Connected to the heat pump ${address}.`, ...notes.map((n) => n.en)].join(' '),
      [`Connecté à la pompe à chaleur ${address}.`, ...notes.map((n) => n.fr)].join(' '),
    ),
  notes: {
    failing: (list) => w(`Not read: ${list}.`, `Non lus : ${list}.`),
    heldSince: (n, since) =>
      w(
        `Heating circuit ${n} held off by Gladys since ${since} (to end it: another mode or "No request" with the commands allowed, or another mode at the panel).`,
        `Circuit de chauffage ${n} maintenu à l'arrêt par Gladys depuis ${since} (pour en sortir : un autre mode ou « Aucune demande » avec les commandes autorisées, ou un autre mode au panneau).`,
      ),
    stopNotApplied: (n) =>
      w(
        `The controller does not apply the stop of heating circuit ${n}: written again every 20 s.`,
        `Le régulateur n'applique pas l'arrêt du circuit de chauffage ${n} : réécrit toutes les 20 s.`,
      ),
    released: (n, reason) =>
      w(
        `Heating circuit ${n} no longer held by Gladys (${reason}).`,
        `Circuit de chauffage ${n} plus maintenu par Gladys (${RELEASE_REASONS[reason]?.fr ?? reason}).`,
      ),
    storeUnavailable: w(
      '/data cannot be read or written: a stop is not kept across a restart.',
      "/data illisible ou non inscriptible : un arrêt n'est pas gardé après un redémarrage.",
    ),
  },
  test: {
    cooldown: w('Already tested a moment ago.', 'Déjà testé il y a un instant.'),
  },
};

/** "30 s", "2 min". */
export function age(ms) {
  const seconds = Math.max(1, Math.round((ms ?? 0) / 1000));
  return seconds < 120 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}

/** Joins two texts { en, fr } (or plain strings). */
export function join(texts) {
  const parts = texts.filter(Boolean);
  return {
    en: parts.map((p) => word(p, 'en')).join(' '),
    fr: parts.map((p) => word(p, 'fr')).join(' '),
  };
}
