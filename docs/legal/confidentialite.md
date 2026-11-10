---
document: privacy
version: 2026-11-v4
title: Politique de confidentialité
updated: 2026-11-01
---

# Politique de confidentialité

> **Modèle à faire valider par un juriste.** Ce texte est un modèle fourni avec le logiciel Alpha. Il doit être relu, adapté aux traitements réellement mis en œuvre et à vos sous-traitants effectifs, puis validé par un professionnel du droit ou votre délégué à la protection des données avant toute mise en production.

Version {{version}} — en vigueur depuis le {{updated}}.

Cette politique explique quelles données personnelles nous traitons lorsque vous utilisez Alpha ({{app_url}}), pourquoi, sur quelle base légale, avec qui elles sont partagées, combien de temps elles sont conservées et comment exercer vos droits, conformément au règlement (UE) 2016/679 (« RGPD ») et à la loi n° 78-17 du 6 janvier 1978 modifiée (« Informatique et Libertés »).

## 1. Responsable du traitement

Le responsable du traitement est {{company_name}}, {{legal_form}}, dont le siège est situé {{address}}, immatriculée {{registration}}, représentée par {{director}}.

- Contact : {{email}}
- Délégué à la protection des données (DPO) : {{dpo_email}}

## 2. Données que nous traitons

- **Compte** : nom, adresse e-mail, mot de passe (stocké uniquement sous forme d’empreinte scrypt), rôle, date d’inscription, vérification de l’e-mail, double authentification (sans que le secret ne soit jamais affiché), comptes externes associés (GitHub, GitLab, Figma, Google).
- **Profil professionnel** : titre, biographie, compétences, couleur d’avatar, organisations, abonnements.
- **Contenus** : projets, tâches, publications, commentaires, messages, avis, annonces, rapports de tests, fichiers déposés.
- **Transactions** : commandes, campagnes, missions, paiements, écritures comptables, retraits, moyens de paiement (gérés par les prestataires de paiement : nous ne stockons jamais les numéros de carte).
- **Vérification d’identité (KYC)** : lorsque la réglementation l’exige pour les retraits ou les vendeurs, pièce d’identité et justificatifs, transmis au prestataire de paiement réglementé ou conservés de façon chiffrée.
- **Sécurité** : sessions (date de création, d’expiration), journaux d’audit, compteurs anti-abus (identifiants hachés), signaux anti-fraude, identifiant aléatoire d’appareil.
- **Communications** : notifications, e-mails transactionnels envoyés, consentements et leur historique.

Nous ne traitons pas de données sensibles au sens de l’article 9 du RGPD. Merci de ne pas en publier.

## 3. Finalités et bases légales

| Finalité | Base légale (art. 6 RGPD) |
| --- | --- |
| Création et gestion du compte, authentification | Exécution du contrat (6.1.b) |
| Fourniture du service : projets, réseau, messagerie, tests, marketplace | Exécution du contrat (6.1.b) |
| Paiements, séquestre, commissions, retraits, facturation | Exécution du contrat (6.1.b) et obligations légales comptables et fiscales (6.1.c) |
| Vérification d’identité et lutte contre le blanchiment (LCB-FT) | Obligation légale (6.1.c) |
| Sécurité, prévention de la fraude et des abus, journalisation | Intérêt légitime (6.1.f) : protéger les membres et la Plateforme |
| Modération et traitement des signalements (règlement sur les services numériques) | Obligation légale (6.1.c) et intérêt légitime (6.1.f) |
| E-mails transactionnels (sécurité, paiements, missions) | Exécution du contrat (6.1.b) |
| E-mails promotionnels et nouveautés | Consentement (6.1.a), retirable à tout moment |
| Mesure d’audience | Consentement (6.1.a) ; désactivée par défaut |
| Réponse aux demandes d’exercice des droits | Obligation légale (6.1.c) |

Aucune décision produisant des effets juridiques n’est prise sur le seul fondement d’un traitement automatisé : les signaux anti-fraude déclenchent une vérification humaine et toute restriction peut être contestée.

## 4. Destinataires et sous-traitants

Vos données sont accessibles aux seules personnes habilitées de l’Éditeur et, selon la visibilité que vous choisissez, aux autres membres. Nous faisons appel aux sous-traitants et partenaires suivants, chacun limité à sa mission :

| Destinataire | Rôle | Localisation / transferts |
| --- | --- | --- |
| {{host_name}} | Hébergement de la Plateforme et des sauvegardes | Selon le contrat d’hébergement |
| Fournisseur d’envoi d’e-mails (SMTP) configuré par l’Éditeur | Envoi des e-mails transactionnels et, avec votre accord, promotionnels | Selon le fournisseur retenu |
| Stripe | Paiements par carte, prélèvements, virements | Union européenne et États-Unis |
| Flutterwave | Paiements et retraits en Afrique | Nigeria, États-Unis et autres pays d’opération |
| CamPay | Paiements Mobile Money au Cameroun | Cameroun |
| MTN Mobile Money | Paiements et retraits Mobile Money | Pays d’opération de MTN |
| Orange Money | Paiements et retraits Mobile Money | Pays d’opération d’Orange Money |
| Wave | Paiements et retraits Mobile Money | Sénégal, Côte d’Ivoire et autres pays d’opération |
| Kratos Pay | Paiements et retraits | Pays d’opération du prestataire |
| ClamAV | Analyse antivirus des fichiers déposés | Exécuté sur nos propres serveurs : aucun transfert |
| GitHub, GitLab, Figma, Google | Connexion par compte externe et intégrations que vous activez | Principalement États-Unis |

Les prestataires de paiement agissent généralement en tant que responsables de traitement distincts pour leurs propres obligations réglementaires (vérification d’identité, lutte contre la fraude et le blanchiment). Leurs politiques de confidentialité s’appliquent alors en complément.

Vos données peuvent être communiquées aux autorités administratives ou judiciaires sur réquisition légale.

## 5. Transferts hors de l’Union européenne

Certains destinataires sont situés hors de l’Espace économique européen. Ces transferts sont encadrés, selon le cas, par une décision d’adéquation de la Commission européenne (par exemple le cadre de protection des données UE–États-Unis pour les entreprises certifiées), par des clauses contractuelles types de la Commission européenne assorties de mesures complémentaires, ou, pour les paiements Mobile Money que vous choisissez d’effectuer vers un pays tiers, par la nécessité du transfert à l’exécution du contrat conclu à votre demande (article 49.1.b du RGPD). Vous pouvez obtenir une copie des garanties applicables en écrivant à {{dpo_email}}.

## 6. Durées de conservation

| Données | Durée |
| --- | --- |
| Compte et profil | Durée de l’inscription ; suppression ou anonymisation 30 jours après votre demande de suppression |
| Contenus publiés, messages | Durée de l’inscription ; à la suppression du compte, le texte est remplacé par une mention « supprimé » pour préserver les conversations des autres membres |
| Sessions de connexion | Jusqu’à leur expiration (7 jours) ou votre déconnexion |
| Notifications lues | 12 mois |
| E-mails envoyés (journal d’envoi) | 90 jours ; 180 jours en cas d’échec d’envoi |
| Compteurs anti-abus | Jusqu’à la fin de la fenêtre de limitation (quelques minutes à 24 heures) |
| Signaux anti-fraude | 180 jours, sauf procédure en cours |
| Journaux d’audit ordinaires | 3 ans |
| Journaux d’audit relatifs à l’argent, à la confiance, à la modération et au RGPD | 10 ans |
| Pièces comptables, transactions et grand livre | 10 ans (article L123-22 du Code de commerce), sous un identifiant anonymisé après suppression du compte |
| Documents de vérification d’identité (KYC) | 5 ans après la fin de la relation (article L561-12 du Code monétaire et financier) |
| Preuves d’acceptation des documents et historique des consentements | Durée du compte puis 5 ans (prescription), rattachés à l’identifiant anonymisé |
| Demandes d’exercice des droits | 3 ans après leur clôture |
| Lien de téléchargement de votre export | 7 jours ; l’archive est générée à la demande et n’est jamais stockée |

## 7. Vos droits

Vous disposez d’un droit d’accès, de rectification, d’effacement, de limitation, d’opposition et de portabilité de vos données, du droit de retirer votre consentement à tout moment et du droit de définir des directives relatives au sort de vos données après votre décès (article 85 de la loi Informatique et Libertés).

Depuis vos [paramètres](/settings), vous pouvez directement :

- **télécharger vos données** dans un format JSON structuré et réutilisable (articles 15 et 20) ; une demande par 24 heures, lien valable 7 jours ;
- **gérer vos consentements** (e-mails promotionnels, nouveautés, mesure d’audience) avec l’historique de vos choix ;
- **supprimer votre compte** (article 17) : la suppression intervient après un délai de 30 jours pendant lequel vous pouvez l’annuler. Certaines données sont conservées lorsque la loi l’impose (comptabilité, lutte contre la fraude et le blanchiment), sans lien avec votre identité ;
- **corriger votre profil** à tout moment.

Pour toute autre demande, écrivez à {{dpo_email}}. Nous répondons dans un délai d’un mois, prolongeable de deux mois pour les demandes complexes ; nous pouvons vous demander de justifier de votre identité en cas de doute raisonnable.

Si vous estimez que vos droits ne sont pas respectés, vous pouvez introduire une réclamation auprès de la Commission nationale de l’informatique et des libertés (CNIL), 3 place de Fontenoy, TSA 80715, 75334 Paris Cedex 07, [www.cnil.fr](https://www.cnil.fr/fr/plaintes).

## 8. Cookies et stockage local

Alpha n’utilise **aucun cookie publicitaire ni traceur tiers**. Seuls sont utilisés :

- le cookie de session `alpha_session` (HttpOnly, 7 jours), strictement nécessaire à l’authentification ;
- un identifiant aléatoire d’appareil `alpha_device` conservé dans le stockage local du navigateur, utilisé uniquement pour la sécurité du compte et la prévention des abus (il est haché côté serveur et n’est jamais utilisé à des fins publicitaires) ;
- des préférences d’affichage temporaires dans le stockage de session (par exemple le report d’une bannière).

Ces traceurs sont strictement nécessaires au service ou à sa sécurité et sont, à ce titre, exemptés de consentement (article 82 de la loi Informatique et Libertés et lignes directrices de la CNIL). Si une mesure d’audience non exemptée est activée, elle ne fonctionne qu’avec votre consentement explicite.

## 9. Sécurité

Nous mettons en œuvre des mesures techniques et organisationnelles adaptées : chiffrement des échanges (TLS), empreintes de mots de passe scrypt, jetons de session hachés, chiffrement des secrets (AES-256-GCM), double authentification, contrôle d’accès par rôle, journal d’audit, limitation de débit, analyse antivirus des fichiers et sauvegardes. En cas de violation de données présentant un risque, nous notifions la CNIL dans les 72 heures et vous informons sans délai si le risque est élevé.

## 10. Mineurs

Les fonctions de paiement sont réservées aux personnes majeures. Les mineurs de moins de 15 ans ne peuvent pas s’inscrire sans l’accord d’un titulaire de l’autorité parentale.

## 11. Modifications

Nous pouvons faire évoluer cette politique. Chaque version est numérotée ; en cas de changement important, nous vous en informons et vous demandons, le cas échéant, de renouveler votre acceptation ou vos consentements.

Voir aussi : [mentions légales](/legal/legal_notice) · [conditions générales](/legal/terms).
