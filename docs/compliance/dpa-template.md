# Data processing agreement (DPA) template — hosted client sites (BF-062)

> **Not legal advice.** This is a template for the agency to sign with each client whose website it hosts. Have it
> reviewed by a lawyer before first use, and again when the hosting setup changes. `needs_legal_review`.

## How to use this template

- **What it is.** When a client's site goes live, the agency hosts it and handles personal data on the client's behalf
  (contact-form submissions, aggregate visit counts, the client's portal account). GDPR article 28 requires a written
  contract between the **client (controller)** and the **agency (processor)**. This file is that contract, as a
  template, in French then in English. Both versions say the same thing; keep the one(s) your client reads.
- **It is a template, not legal advice.** Have it reviewed by a qualified person, and adapt it to your situation
  (liability caps, governing law, insurance). Saint-Barthélemy applies French data-protection law; the EU GDPR applies
  to the agency's EU-facing activities and to clients established in the EU. Confirm the arrangement for your agency.
- **Fill the placeholders** `[in brackets]`: legal names, registration numbers, addresses, the signatory, the
  retention period you configured for the site, the sub-processors of your deployment (Annex 2) and the measures you
  actually operate (Annex 1 lists what the platform does by default; remove what you do not run).
- **Sign it with each client before go-live.** The go-live wizard's legal step records who, on the client's side,
  confirmed the site's content and when, and when the privacy notice was read and accepted (the site's legal
  profile). That record is not this agreement: **it does not replace the signed DPA**. Keep a signed copy (paper or electronic signature) with the client's file.
- **Produce a PDF** with any Markdown-to-PDF tool, for example `pandoc dpa.md -o dpa.pdf`, after copying this file and
  deleting the section you are reading and the version in the other language.
- **Keep it in sync** with `docs/compliance/data-map.md` (records of processing) and with the site's privacy page: the
  purposes, retention and sub-processors must match what the site tells its visitors.

---

# Accord de traitement des données (article 28 RGPD)

**Entre**

**[Dénomination sociale du client]**, [forme juridique], immatriculée sous le numéro [SIREN / RCS], dont le siège est
situé [adresse], représentée par [nom et qualité du signataire], ci-après « le **Client** » ou « le **Responsable du
traitement** » ;

**et**

**[Dénomination sociale de l'agence]**, [forme juridique], immatriculée sous le numéro [SIREN / RCS], dont le siège est
situé [adresse], représentée par [nom et qualité du signataire], ci-après « l'**Agence** » ou « le **Sous-traitant** ».

Ensemble « les Parties ».

## 1. Objet et durée

1.1. Le présent accord encadre le traitement de données à caractère personnel effectué par l'Agence pour le compte du
Client dans le cadre de l'hébergement et de l'exploitation du site web du Client, **[nom du site / domaine]**
(ci-après « le Site »), conformément à l'article 28 du Règlement (UE) 2016/679 (« RGPD ») et à la loi n° 78-17 du
6 janvier 1978 modifiée.

1.2. Il complète le contrat de prestation du [date] (ci-après « le Contrat principal »). En cas de contradiction sur la
protection des données, le présent accord prévaut.

1.3. Il entre en vigueur à la signature, au plus tard à la mise en ligne du Site, et reste en vigueur tant que l'Agence
traite des données pour le compte du Client, puis jusqu'à la suppression ou la restitution prévue à l'article 10.

## 2. Nature et finalités du traitement

| Traitement | Nature | Finalité |
|---|---|---|
| Formulaire de contact | Collecte, transmission par e-mail, conservation, affichage dans le tableau de bord, suppression | Permettre aux visiteurs de contacter le Client et au Client de répondre |
| Mesure d'audience sans cookie | Comptage agrégé des pages vues et estimation du nombre de visiteurs uniques | Informer le Client de la fréquentation de son Site |
| Portail client | Création et gestion du compte du représentant du Client, connexion par lien magique | Donner au Client accès à son Site, ses statistiques, ses demandes de contact et ses demandes de modification |
| Hébergement et sauvegardes | Stockage, sauvegarde, restauration | Assurer la disponibilité et l'intégrité du Site |

L'Agence ne traite ces données que pour ces finalités et sur instruction documentée du Client.

## 3. Types de données à caractère personnel

- **Demandes de contact** : nom, adresse e-mail, numéro de téléphone (facultatif), message libre, preuve du
  consentement (texte affiché, version, horodatage, locale).
- **Mesure d'audience** : aucune donnée directement identifiante. Aucune adresse IP ni chaîne user-agent n'est
  conservée ; le nombre de visiteurs uniques est une estimation statistique (HyperLogLog) calculée à partir d'un
  condensé non réversible et salé quotidiennement.
- **Portail client** : adresse e-mail du représentant du Client, journal des connexions et des actions.
- **Demandes de modification** : texte, captures d'écran fournies par le Client.

Aucune donnée dite « sensible » (article 9 RGPD) n'est attendue. Le Client s'engage à ne pas en solliciter via le Site
sans accord écrit préalable de l'Agence.

## 4. Catégories de personnes concernées

- Visiteurs du Site qui utilisent le formulaire de contact ;
- Visiteurs du Site (données agrégées uniquement) ;
- Représentants et salariés du Client disposant d'un accès au portail.

## 5. Obligations et droits du Client (responsable du traitement)

Le Client :

- a. détermine les finalités et les moyens du traitement et garantit qu'il dispose d'une base légale pour chaque
  traitement confié ;
- b. fournit, et maintient à jour, les informations publiées sur le Site (mentions légales, politique de
  confidentialité) à partir des modèles proposés par l'Agence, qu'il a vérifiés ;
- c. confirme l'adresse e-mail de réception des demandes de contact et en garde l'accès sécurisé ;
- d. choisit la durée de conservation des demandes de contact (article 10) ;
- e. répond aux demandes des personnes concernées, avec l'assistance de l'Agence (article 8) ;
- f. donne ses instructions par écrit (y compris via le tableau de bord et le portail) ;
- g. peut auditer le respect du présent accord (article 11).

## 6. Obligations de l'Agence (sous-traitant)

L'Agence s'engage à :

- a. **Instructions.** Ne traiter les données que sur instruction documentée du Client, y compris pour les transferts
  hors UE/EEE, sauf obligation légale ; dans ce cas, en informer le Client avant le traitement, sauf interdiction
  légale. Informer le Client si une instruction lui paraît contraire au RGPD.
- b. **Confidentialité.** Veiller à ce que les personnes autorisées à traiter les données soient tenues à une
  obligation de confidentialité contractuelle ou légale, et formées à la protection des données.
- c. **Sécurité (article 32 RGPD).** Mettre en œuvre les mesures techniques et organisationnelles de l'Annexe 1,
  notamment : chiffrement TLS de tous les échanges (site, tableau de bord, portail, API, e-mails sortants), chiffrement
  au repos des secrets et des identifiants, contrôle d'accès par rôle avec isolation par client, journalisation des
  actions sensibles dans un journal d'audit inaltérable, sauvegardes chiffrées et testées, absence de conservation des
  adresses IP et des user-agents pour la mesure d'audience, minimisation des données collectées.
- d. **Registre.** Tenir un registre des catégories d'activités de traitement effectuées pour le compte du Client.
- e. **Délégué.** Désigner un point de contact pour la protection des données : [nom / adresse e-mail générique].
- f. **Localisation.** Héberger et traiter les données dans l'Union européenne ou l'EEE, sauf accord écrit du Client
  (article 12).
- g. **Personnel et prestataires.** Ne donner accès aux données qu'aux membres de son équipe qui en ont besoin.

## 7. Sous-traitants ultérieurs

7.1. Le Client autorise de manière générale l'Agence à recourir aux sous-traitants ultérieurs listés à l'**Annexe 2**.

7.2. L'Agence informe le Client par écrit (e-mail à l'adresse de contact du Client) de tout ajout ou remplacement
envisagé **au moins trente (30) jours** avant sa mise en œuvre. Le Client peut s'y opposer par écrit dans ce délai pour
des motifs légitimes liés à la protection des données. À défaut d'accord, chaque Partie peut résilier la prestation
d'hébergement, sans indemnité, avec restitution des données selon l'article 10.

7.3. L'Agence impose à chaque sous-traitant ultérieur, par contrat, des obligations de protection des données
équivalentes à celles du présent accord et reste pleinement responsable envers le Client de leur exécution.

## 8. Assistance au Client

8.1. **Droits des personnes.** L'Agence transmet au Client, sans délai, toute demande d'exercice de droits (accès,
rectification, effacement, limitation, portabilité, opposition) reçue directement, et l'aide à y répondre dans le délai
d'un mois : recherche, export et suppression des données concernées depuis le tableau de bord (Conformité →
Demandes), avec trace auditée.

8.2. **Analyse d'impact et consultation préalable.** L'Agence fournit au Client les informations dont elle dispose sur
le traitement pour l'aider à réaliser une analyse d'impact (articles 35 et 36 RGPD) si celle-ci est requise.

8.3. **Sécurité.** L'Agence aide le Client à satisfaire ses obligations des articles 32 à 34 RGPD, compte tenu de la
nature du traitement et des informations à sa disposition.

## 9. Violation de données

9.1. L'Agence notifie au Client toute violation de données à caractère personnel **dans les meilleurs délais après en
avoir eu connaissance, avec un objectif de quarante-huit (48) heures**, à l'adresse de contact du Client.

9.2. La notification décrit, dans la mesure du possible, la nature de la violation, les catégories et le nombre
approximatif de personnes et d'enregistrements concernés, les conséquences probables, les mesures prises ou
proposées, et le point de contact. Les informations peuvent être communiquées de manière échelonnée.

9.3. L'Agence coopère avec le Client pour la notification à la CNIL (72 heures) et, le cas échéant, l'information des
personnes concernées. Elle ne notifie pas l'autorité ni les personnes au nom du Client sans instruction.

## 10. Conservation, restitution et suppression

10.1. **Conservation.** Les demandes de contact sont conservées **[24] mois** à compter de leur réception, puis
supprimées automatiquement (durée configurable par le Client dans le tableau de bord ; 24 mois est la valeur
suggérée). Les mesures d'audience ne contiennent pas de données identifiantes et sont conservées en agrégats. Les
comptes du portail sont supprimés à la fin du Contrat principal.

10.2. **Fin du contrat.** À la fin de la prestation d'hébergement, l'Agence :

- a. remet au Client, sur demande, un **export statique du Site** (pages HTML, CSS, polices et ressources) ;
- b. remet au Client un **export des demandes de contact** dans un format structuré courant (CSV ou JSON) ;
- c. **supprime** les demandes de contact, les comptes du portail et les copies existantes **dans les trente (30)
  jours** suivant la remise des exports, sauf obligation légale de conservation, et le confirme par écrit ;
- d. les sauvegardes sont écrasées selon leur cycle de rotation (Annexe 1), sans restauration des données supprimées.

10.3. Le Client choisit entre restitution puis suppression, ou suppression seule, par écrit avant la fin du contrat.
À défaut de choix dans les trente (30) jours suivant la fin, l'Agence supprime.

## 11. Audits

11.1. L'Agence met à disposition du Client toutes les informations nécessaires pour démontrer le respect du présent
accord : description des mesures (Annexe 1), liste des sous-traitants (Annexe 2), extraits du journal d'audit relatifs
au Site, rapports de sécurité disponibles.

11.2. Le Client, ou un auditeur indépendant mandaté par lui et tenu au secret, peut réaliser un audit **une fois par an
au plus** (sauf violation de données ou demande d'une autorité), avec un préavis de trente (30) jours, pendant les
heures ouvrées, sans perturber l'exploitation ni accéder aux données d'autres clients de l'Agence. Les coûts sont à la
charge du Client sauf si l'audit révèle un manquement substantiel.

## 12. Transferts internationaux

12.1. Par défaut, les données sont hébergées et traitées dans l'Union européenne ou l'EEE.

12.2. Si un sous-traitant ultérieur listé en Annexe 2 est établi hors de l'EEE ou y accède, le transfert repose sur une
décision d'adéquation de la Commission européenne ou sur les clauses contractuelles types (décision 2021/914),
complétées si nécessaire par des mesures supplémentaires. L'Annexe 2 indique le mécanisme utilisé pour chaque
sous-traitant.

12.3. Saint-Barthélemy n'est pas membre de l'Union européenne mais applique le droit français de la protection des
données. **[À confirmer par le conseil des Parties : qualification des flux entre le Client, l'Agence et les
sous-traitants établis dans l'UE.]**

## 13. Responsabilité

13.1. Chaque Partie est responsable des dommages qu'elle cause par un manquement au présent accord ou au RGPD, dans
les conditions de l'article 82 RGPD.

13.2. **[Plafond de responsabilité, exclusions et assurance : à aligner sur le Contrat principal, par exemple « la
responsabilité totale de l'Agence au titre du présent accord est limitée à [montant / X fois les sommes versées au
cours des douze derniers mois] », sous réserve des dommages causés intentionnellement ou par faute lourde.]**

## 14. Dispositions générales

14.1. Droit applicable : droit français. Juridiction compétente : **[tribunal]**, après tentative de résolution amiable.

14.2. Toute modification du présent accord fait l'objet d'un avenant écrit signé par les deux Parties, à l'exception
de l'actualisation de l'Annexe 2 selon la procédure de l'article 7.

14.3. Les Annexes 1 et 2 font partie intégrante du présent accord.

## 15. Signatures

| Pour le Client | Pour l'Agence |
|---|---|
| Nom : [nom] | Nom : [nom] |
| Qualité : [qualité] | Qualité : [qualité] |
| Lieu et date : [lieu, date] | Lieu et date : [lieu, date] |
| Signature : | Signature : |

---

# Data processing agreement (GDPR article 28)

**Between**

**[Client legal name]**, [legal form], registered under number [registration number], with its registered office at
[address], represented by [name and title of signatory], hereafter the "**Client**" or the "**Controller**";

**and**

**[Agency legal name]**, [legal form], registered under number [registration number], with its registered office at
[address], represented by [name and title of signatory], hereafter the "**Agency**" or the "**Processor**".

Together the "Parties".

## 1. Subject matter and duration

1.1. This agreement governs the processing of personal data that the Agency carries out on behalf of the Client when
hosting and operating the Client's website, **[site name / domain]** (the "Site"), in accordance with article 28 of
Regulation (EU) 2016/679 (the "GDPR") and French Law no. 78-17 of 6 January 1978 as amended.

1.2. It supplements the services contract dated [date] (the "Main Contract"). Where they conflict on data protection,
this agreement prevails.

1.3. It takes effect on signature, and at the latest when the Site goes live, and remains in force for as long as the
Agency processes data on the Client's behalf, and then until the deletion or return described in clause 10.

## 2. Nature and purpose of the processing

| Processing | Nature | Purpose |
|---|---|---|
| Contact form | Collection, delivery by email, storage, display in the dashboard, deletion | Let visitors contact the Client and let the Client reply |
| Cookieless analytics | Aggregate page-view counts and an estimate of unique visitors | Tell the Client how the Site is visited |
| Client portal | Creation and management of the Client representative's account, magic-link sign-in | Give the Client access to its Site, statistics, contact requests and change requests |
| Hosting and backups | Storage, backup, restoration | Keep the Site available and intact |

The Agency processes this data only for these purposes and on the Client's documented instructions.

## 3. Types of personal data

- **Contact requests**: name, email address, phone number (optional), free-text message, consent record (text shown,
  version, timestamp, locale).
- **Analytics**: no directly identifying data. No IP address or user-agent string is stored; the unique-visitor count
  is a statistical estimate (HyperLogLog) computed from a non-reversible, daily-salted digest.
- **Client portal**: the Client representative's email address, sign-in and action log.
- **Change requests**: text and screenshots supplied by the Client.

No special-category data (GDPR article 9) is expected. The Client undertakes not to request such data through the Site
without the Agency's prior written agreement.

## 4. Categories of data subjects

- Visitors of the Site who use the contact form;
- Visitors of the Site (aggregate data only);
- Representatives and staff of the Client with access to the portal.

## 5. Obligations and rights of the Client (controller)

The Client:

- a. determines the purposes and means of the processing and warrants that it has a lawful basis for each processing
  entrusted to the Agency;
- b. provides, and keeps current, the information published on the Site (legal notice, privacy policy), starting from
  the templates the Agency supplies, which the Client has reviewed;
- c. confirms the email address that receives contact requests and keeps access to it secure;
- d. chooses the retention period for contact requests (clause 10);
- e. answers data-subject requests, with the Agency's assistance (clause 8);
- f. gives its instructions in writing (including through the dashboard and the portal);
- g. may audit compliance with this agreement (clause 11).

## 6. Obligations of the Agency (processor)

The Agency shall:

- a. **Instructions.** Process the data only on the Client's documented instructions, including for transfers outside
  the EU/EEA, unless required by law; in that case inform the Client before processing, unless the law forbids it.
  Inform the Client if an instruction appears to infringe the GDPR.
- b. **Confidentiality.** Ensure that persons authorised to process the data are bound by a contractual or statutory
  duty of confidentiality and trained in data protection.
- c. **Security (GDPR article 32).** Implement the technical and organisational measures of Annex 1, including: TLS
  encryption of all traffic (site, dashboard, portal, API, outgoing email), encryption at rest of secrets and
  credentials, role-based access control with per-client isolation, logging of sensitive actions in an append-only
  audit log, encrypted and tested backups, no storage of IP addresses or user agents for analytics, and minimisation of
  the data collected.
- d. **Records.** Maintain a record of the categories of processing activities carried out on behalf of the Client.
- e. **Contact point.** Designate a data-protection contact: [name / generic email address].
- f. **Location.** Host and process the data in the European Union or the EEA unless the Client agrees otherwise in
  writing (clause 12).
- g. **Staff and suppliers.** Give access to the data only to the members of its team who need it.

## 7. Sub-processors

7.1. The Client gives the Agency general authorisation to engage the sub-processors listed in **Annex 2**.

7.2. The Agency informs the Client in writing (email to the Client's contact address) of any intended addition or
replacement **at least thirty (30) days** before it takes effect. The Client may object in writing within that period
on legitimate data-protection grounds. If no agreement is reached, either Party may terminate the hosting service
without indemnity, with return of the data under clause 10.

7.3. The Agency imposes on each sub-processor, by contract, data-protection obligations equivalent to those of this
agreement and remains fully liable to the Client for their performance.

## 8. Assistance to the Client

8.1. **Data-subject rights.** The Agency forwards to the Client, without delay, any request to exercise rights (access,
rectification, erasure, restriction, portability, objection) that it receives directly, and helps the Client answer
within one month: search, export and deletion of the data concerned from the dashboard (Compliance → Data requests),
with an audited trail.

8.2. **Impact assessments and prior consultation.** The Agency provides the Client with the information it holds about
the processing to help the Client carry out a data protection impact assessment (GDPR articles 35 and 36) where one is
required.

8.3. **Security.** The Agency assists the Client in meeting its obligations under GDPR articles 32 to 34, taking into
account the nature of the processing and the information available to it.

## 9. Personal data breaches

9.1. The Agency notifies the Client of any personal data breach **without undue delay after becoming aware of it, with
a target of forty-eight (48) hours**, at the Client's contact address.

9.2. The notification describes, as far as possible, the nature of the breach, the categories and approximate number
of data subjects and records concerned, the likely consequences, the measures taken or proposed, and the contact
point. Information may be provided in phases.

9.3. The Agency cooperates with the Client on the notification to the supervisory authority (CNIL, 72 hours) and, where
applicable, the communication to the data subjects. It does not notify the authority or the data subjects on the
Client's behalf without instruction.

## 10. Retention, return and deletion

10.1. **Retention.** Contact requests are kept for **[24] months** from receipt and then deleted automatically (the
Client configures the period in the dashboard; 24 months is the suggested value). Analytics hold no identifying data
and are kept as aggregates. Portal accounts are deleted at the end of the Main Contract.

10.2. **End of contract.** When the hosting service ends, the Agency:

- a. offers the Client a **static export of the Site** (HTML pages, CSS, fonts and assets);
- b. provides the Client with an **export of the contact requests** in a common structured format (CSV or JSON);
- c. **deletes** the contact requests, the portal accounts and existing copies **within thirty (30) days** of
  delivering the exports, unless the law requires retention, and confirms the deletion in writing;
- d. lets backups expire according to their rotation cycle (Annex 1), without restoring deleted data.

10.3. The Client chooses, in writing before the end of the contract, between return followed by deletion, or deletion
only. If no choice is made within thirty (30) days of the end, the Agency deletes.

## 11. Audits

11.1. The Agency makes available to the Client all information necessary to demonstrate compliance with this
agreement: description of the measures (Annex 1), list of sub-processors (Annex 2), audit-log extracts relating to the
Site, and available security reports.

11.2. The Client, or an independent auditor it appoints who is bound by confidentiality, may carry out an audit **at
most once a year** (except after a data breach or at the request of an authority), with thirty (30) days' notice,
during business hours, without disrupting operations or accessing other clients' data. The Client bears the costs
unless the audit reveals a material breach.

## 12. International transfers

12.1. By default, the data is hosted and processed in the European Union or the EEA.

12.2. If a sub-processor listed in Annex 2 is established outside the EEA or accesses the data from outside it, the
transfer relies on an adequacy decision of the European Commission or on the Standard Contractual Clauses (Decision
2021/914), supplemented where necessary by additional measures. Annex 2 states the mechanism for each sub-processor.

12.3. Saint-Barthélemy is not part of the European Union but applies French data-protection law. **[To be confirmed by
the Parties' counsel: qualification of the flows between the Client, the Agency and sub-processors established in the
EU.]**

## 13. Liability

13.1. Each Party is liable for the damage it causes by breaching this agreement or the GDPR, under the conditions of
GDPR article 82.

13.2. **[Liability cap, exclusions and insurance: align with the Main Contract, for example "the Agency's total
liability under this agreement is limited to [amount / X times the fees paid in the last twelve months]", except for
damage caused intentionally or by gross negligence.]**

## 14. General provisions

14.1. Governing law: French law. Competent court: **[court]**, after an attempt at amicable resolution.

14.2. Any amendment to this agreement requires a written addendum signed by both Parties, except updates to Annex 2
under the procedure of clause 7.

14.3. Annexes 1 and 2 form an integral part of this agreement.

## 15. Signatures

| For the Client | For the Agency |
|---|---|
| Name: [name] | Name: [name] |
| Title: [title] | Title: [title] |
| Place and date: [place, date] | Place and date: [place, date] |
| Signature: | Signature: |

---

# Annex 1 — Technical and organisational measures / Annexe 1 — Mesures techniques et organisationnelles

Measures the platform applies by default. Remove any line that does not apply to your deployment, and add your own
(office security, device policy, insurance). *Mesures appliquées par défaut par la plateforme ; retirer celles qui ne
s'appliquent pas à votre déploiement et ajouter les vôtres.*

| Area / Domaine | Measure / Mesure |
|---|---|
| Transport encryption | TLS 1.2+ on every hostname (automatic certificates, HSTS); the dashboard, portal and API are HTTPS-only; outgoing email uses TLS to the SMTP provider. |
| Encryption at rest | Secrets, credentials and sealed fields are envelope-encrypted per workspace with a master key kept outside the database; disks and backups encrypted by the hosting provider. |
| Access control | Role-based access (owner, admin, member, viewer, client); client-portal accounts are scoped to their own site(s); every query is filtered by the authenticated workspace; magic-link sign-in with short-lived, single-use tokens. |
| Audit logging | Sensitive actions (sign-ins, exports, deletions, legal confirmations, domain changes) are recorded in an append-only audit log with actor, time and correlation id; no IP addresses in audit entries. |
| Backups | Encrypted database backups on a fixed schedule [daily], retained [30] days, restoration tested [quarterly]; backups are not used to restore data that was deleted on request. |
| Analytics without identifiers | No IP address, user agent or cookie is stored; unique visitors are a HyperLogLog estimate from a daily-salted hash; only aggregates are kept. |
| Data minimisation | The contact form collects name, email, optional phone and message only; consent record kept with the submission; analytics are aggregates; spam submissions deleted after 30 days. |
| Retention | Automatic deletion of contact requests after the configured period ([24] months by default); DSR exports deleted 30 days after completion; retention policies visible in the dashboard. |
| Data-subject requests | Search, export and erasure tools in the dashboard, with a recorded verification and an audited trail; one-month deadline tracked. |
| Secure development | Dependencies pinned and scanned; lint, type and test gates in CI; secrets never committed; SSRF guard on outbound requests; crawled content treated as untrusted. |
| Isolation | Coding agents and build jobs run in an isolated sandbox with no database access; each client site served under its own hostname; cross-tenant isolation covered by automated tests. |
| Monitoring | Certificate-expiry and uptime alerts; error tracking without personal data in payloads (if enabled, see Annex 2); logs redact secrets and message content. |
| Organisational | Confidentiality clauses for staff and freelancers; least-privilege accounts with two-factor authentication on provider consoles; offboarding checklist revoking access; breach-response procedure with the 48-hour target of clause 9. |

# Annex 2 — Sub-processors / Annexe 2 — Sous-traitants ultérieurs

Fill one row per provider of your deployment. Keep this list identical to the "recipients" section of the Site's
privacy page. *Une ligne par prestataire de votre déploiement ; garder cette liste identique à la section
« destinataires » de la politique de confidentialité du Site.*

| Role / Rôle | Provider (legal name) / Prestataire | Data concerned / Données concernées | Location / Localisation | Transfer mechanism / Mécanisme de transfert |
|---|---|---|---|---|
| Hosting (VPS, database, cache) / Hébergement | [Hosting provider legal name] | All stored data / Toutes les données stockées | [Country, EU] | None required (EU) / Aucun (UE) |
| Object storage (S3-compatible) / Stockage objet | [Storage provider legal name] | Site assets, uploads, exports, backups / Ressources du site, fichiers, exports, sauvegardes | [Country, EU] | None required (EU) / Aucun (UE) |
| Transactional email (SMTP) / E-mail transactionnel | [Email provider legal name] | Contact-request notifications, magic links, confirmations / Notifications de contact, liens de connexion, confirmations | [Country] | [None (EU) / SCCs / Adequacy decision] |
| Error tracking (optional) / Suivi des erreurs (optionnel) | [Error-tracking provider legal name, or "not used"] | Technical error reports without personal data / Rapports d'erreur techniques sans données personnelles | [Country] | [None (EU) / SCCs / Adequacy decision] |
| [Other / Autre] | [Legal name] | [Data] | [Country] | [Mechanism] |

Last updated / Dernière mise à jour : [date]. Changes are notified under clause 7 / Les modifications sont notifiées
selon l'article 7.
