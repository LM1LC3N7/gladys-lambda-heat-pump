# Pompe à chaleur Lambda

Affiche une pompe à chaleur Lambda (série EU-L) dans Gladys par l'interface
Modbus TCP de son régulateur, sur votre réseau local, sans cloud.

> Cette intégration n'a jamais été testée avec un vrai appareil : elle suit le
> manuel Modbus du fabricant (« Modbus-Protokoll 1.0 ») et l'intégration Home
> Assistant lambda_heat_pumps. Les retours d'un propriétaire sont bienvenus.
> Sans lien avec Lambda Wärmepumpen.

## Avant de commencer

- Le régulateur répond en Modbus TCP sur le port 502, identifiant d'unité 1,
  tel que livré. Donnez-lui une adresse IP fixe dans votre routeur.
- Modbus n'a pas de mot de passe : tout appareil du réseau peut lire et
  écrire la pompe à chaleur. Gardez-la sur un réseau de confiance, jamais
  joignable depuis Internet.
- Le régulateur ferme une connexion inactive depuis une minute ; Gladys garde
  une connexion et la ferme après 45 s sans requête. Un autre client Modbus
  (Home Assistant, un gestionnaire d'énergie) peut partager le régulateur :
  chacun écrit ses propres demandes.

## Configuration

| Champ                                                                          | Rôle                                                                     |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Adresse IP du régulateur                                                       | adresse IPv4 ou nom d'hôte, `:port` si ce n'est pas 502                  |
| Identifiant d'unité Modbus                                                     | 1 sauf si votre installateur l'a changé                                  |
| Pompes à chaleur, ballons d'eau chaude, ballons tampons, circuits de chauffage | nombre de chaque module, comme sur l'écran (1 à 5, 0 à 5, 0 à 5, 0 à 12) |
| Autoriser les commandes                                                        | désactivé par défaut (voir plus bas)                                     |
| Plafond de l'eau chaude                                                        | 55 °C par défaut, de 40 à 60 °C, jamais plus de 60 °C                    |
| Intervalle de rafraîchissement                                                 | 30 s par défaut, de 10 s à 10 min                                        |

Enregistrez, puis ajoutez les appareils depuis l'onglet Découverte.
« Tester la connexion » affiche l'état de la dernière lecture ; il ne relit
qu'une fois l'intervalle écoulé depuis la dernière lecture.

## Appareils

Un appareil par module, numéroté comme sur l'écran :

- **Système** : température extérieure (moyenne sur 1 h et celle de la
  courbe de chauffe), état et numéro d'erreur, état du gestionnaire
  d'énergie, puissance absorbée des pompes à chaleur (W) et sa consigne.
- **Pompe à chaleur n** : températures de départ, de retour et de la source,
  régime du compresseur (%), puissance de chauffe (kW), puissance absorbée de
  l'onduleur (W), COP, état et numéro d'erreur, état, état de fonctionnement,
  relais de la résistance électrique.
- **Ballon d'eau chaude n** : températures haut, bas et de bouclage, pompe de
  bouclage, état, numéro d'erreur, consigne d'eau chaude.
- **Ballon tampon n** : températures haut et bas, état, numéro d'erreur,
  température maximale.
- **Circuit de chauffage n** : températures de départ, de retour et
  ambiante, consigne de départ calculée, décalage de la courbe de chauffe,
  consignes ambiantes (chauffage, rafraîchissement), état, numéro d'erreur,
  mode de fonctionnement demandé.

Une fonctionnalité apparaît dès que son registre a donné une valeur : 0x8000
(« non disponible »), -3000 (« sonde non raccordée ») et les valeurs hors
d'une plage plausible ne sont jamais publiés. Les registres que seules
certaines versions du logiciel servent (relais de la résistance, gestionnaire
d'énergie, consigne de départ calculée, maximum du tampon) sont laissés de
côté quand le régulateur les refuse. Les statistiques d'énergie des pompes à
chaleur ne sont pas lues (leur ordre des mots a changé avec le logiciel, et
elles peuvent être remises à zéro) : pas d'index d'énergie.

## Commandes

### Arrêter un circuit de chauffage (toujours possible)

Choisir **Arrêt** dans le mode d'un circuit de chauffage l'arrête, quelle
que soit l'option « Autoriser les commandes ». Le mode est une demande
Modbus que le régulateur oublie si elle n'est pas réécrite : Gladys garde
donc l'arrêt. Il est écrit tout de suite (avant les lectures en attente, une
lecture muette depuis une seconde est coupée), relu, gardé dans `/data` et
réécrit toutes les 20 s, y compris après un redémarrage de l'intégration,
avant même que Gladys ou sa configuration soient joints.

L'arrêt n'est refusé ni pour l'option, ni pour une lecture ou une commande
en cours, ni pour une configuration que Gladys ne peut pas lire, ni pour un
`/data` non inscriptible (le statut dit alors que l'arrêt ne survivra pas à
un redémarrage), ni pour un circuit absent de la configuration. Un arrêt que
le régulateur n'acquitte pas, ou relit autrement, reçoit « non confirmé » et
reste réécrit toutes les 20 s. Il n'attend que si aucune adresse n'est
encore connue (pas de configuration et rien dans `/data`) : il est alors
écrit dès qu'elle l'est.

L'arrêt ne prend fin que lorsqu'un autre mode a été écrit (option activée),
ou avec **Aucune demande** : Gladys cesse alors de l'écrire, et le régulateur
revient à son propre réglage quand la demande expire. Une commande envoyée
avant l'arrêt et encore en attente est abandonnée.

### Consignes à leur minimum (toujours possibles)

Une consigne ambiante de 15 °C ou une consigne d'eau chaude de 25 °C est
écrite quelle que soit l'option. Si elle n'est pas relue, les trois lectures
suivantes (dans les 15 minutes) la réécrivent.

### Autres commandes (option « Autoriser les commandes »)

- **Mode** d'un circuit de chauffage : automatique, chauffage automatique,
  rafraîchissement automatique, hors-gel, été, ou « Aucune demande ». Le mode
  choisi est gardé et réécrit toutes les 20 s tant que l'option est activée ;
  désactiver l'option l'arrête, un redémarrage aussi (seul un arrêt est
  gardé). « Manuel » et « Programme de chape » sont affichés par le
  régulateur mais jamais réglés.
- **Consigne ambiante** (chauffage) : de 15 à 40 °C, au dixième de degré.
- **Consigne d'eau chaude** : en degrés entiers, de 25 °C au plafond de la
  configuration (55 °C par défaut, jamais au-dessus de 60 °C). Le plafond est
  vérifié à l'arrivée de la commande et juste avant son envoi.

Chaque commande lit d'abord la valeur actuelle (rien n'est envoyé si elle ne
peut pas être lue), une commande à la fois par module. Elle ne réussit que si
la valeur relue après l'écriture est celle demandée ; sinon Gladys journalise
« pas encore appliqué », « envoyé, sans confirmation » ou « rien envoyé ».
La réponse à Gladys arrive en 3,4 s ; une commande qui attend encore derrière
d'autres est alors acceptée et son résultat journalisé. Elle part dans les
10 s du clic, ou pas du tout.

## Pas (encore) fait

- Jamais testé avec un vrai régulateur : la carte des registres, l'échelle
  du COP et le délai d'expiration d'une demande de mode sont à confirmer sur
  un vrai.
- Pas de module solaire, pas d'index d'énergie, pas de demandes de surplus
  photovoltaïque ni du tampon (elles doivent être réécrites régulièrement et
  pilotent directement la pompe à chaleur).
