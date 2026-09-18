# Operational Planning — functionele verbetering en testverslag

Datum: 18 september 2026. Basis: `7aa5beb` van `Jussabdrol/test`.
Werkbranch: `codex/operational-planning`.

## Doel

Een terugkerende controle moet als afzonderlijke uitvoering traceerbaar blijven:
planning → uitvoeren of gemotiveerd overslaan → bewijs en opvolgactie → terugvinden
bij proces, verantwoordelijke, audit en managementreview.

## Hersteld en verbeterd

| Onderdeel | Geconstateerd gedrag | Nieuw gedrag |
| --- | --- | --- |
| Jaarplanning | Een op 3 februari afgeronde controle van 31 januari bleef in januari achterstallig. | De uitkomst hoort bij de geplande datum; de werkelijke afrondingsdatum blijft apart beschikbaar. |
| Overgeslagen controles | Werden als achterstallig geprojecteerd. | Eigen status, teller en grijze markering; geen achterstand. |
| Afronden vanuit planning | Een ontbrekende uitvoering kon terugvallen op de eerstvolgende taakdatum. | De geselecteerde datum wordt aangemaakt/opgezocht; een verlopen selectie geeft een melding en ververst de planning. |
| Afrondvenster | Verwees naar een niet-bestaand HTML-element en opende daardoor niet vanuit een uitvoering. | Toont taaknaam en geplande datum, met behoud van bestaande notities. |
| Volgorde van uitvoering | Een vooruit afgeronde controle kon later opnieuw de volgende taak worden; heropenen herstelde de eerstvolgende datum niet. | De eerstvolgende datum slaat afgeronde/overgeslagen uitvoeringen over en keert terug naar heropend werk. |
| Genereren uitvoeringen | Een toekomstige uitvoering kon eerdere ontbrekende uitvoeringen blokkeren; oude dagelijkse reeksen stopten na 400 datums. | Ontbrekende datums worden aangevuld, ook bij datumfilters; herhaalde aanroepen maken geen duplicaten. |
| Deactiveren | Open uitvoeringen van inactieve reeksen bleven in het uitvoeringslog en aandachtsoverzicht staan. | Open werk verdwijnt uit deze lijsten; afgeronde en overgeslagen historie blijft beschikbaar. |
| Vervolgacties | Een actie vanuit een controle kreeg niet vanzelf haar proces en verantwoordelijke. | Proces en verantwoordelijke worden uit de brontaak overgenomen wanneer niet ingevuld. |
| Procesnaam wijzigen | Taakcategorie bleef de oude naam houden, waardoor procesfilters werk misten. | De gekoppelde taakcategorie wordt in dezelfde transactie bijgewerkt; ambiguïteit wordt geweigerd. |
| Op-tijd-KPI | Werd geschat uit afstanden tussen afrondingen; eerste afronding gold automatisch als op tijd. | Vergelijkt daadwerkelijke afrondingsdatum met geplande datum. |
| Uitvoeringsfilters | Een filter op uitvoerder kon doorwerken naar open/overgeslagen werk. | Uitvoerdersfilter geldt uitsluitend voor afgeronde uitvoeringen. |
| Mission Control | Uitvoeringen verschenen als nummer zonder verantwoordelijke. | Het aandachtsoverzicht toont taaknaam en verantwoordelijke rol. |

## Samenhang met andere modules

- **Architecture / procesbundels:** procesfilter, proceshernoeming en overerving naar vervolgacties getest.
- **My Tasks:** acties met een verantwoordelijke rol worden teruggevonden bij de gebruiker die deze rol vervult.
- **Audits / Requirements:** relaties tussen normeis, taak, uitvoering en checklist blijven bestaan na afronden en heropenen.
- **Management Reviews:** de bestaande regressietest voor gelijktijdig promoveren van een besluit naar één actie en terugkoppeling van de actiestatus blijft slagen.
- **AI Agent:** de bestaande test bevestigt dat de agent dezelfde afrond- en actieworkflows gebruikt.
- **Document Control:** bestaande bijlage- en opslagcode is niet aangepast. Echte uploads/downloads naar cloudopslag zijn niet live getest.

## Verificatie

- Nulmeting: `npm run verify`, 22 tests geslaagd.
- Eerst zes nieuwe regressies toegevoegd: alle zes reproduceerden fouten in de uitgangssituatie.
- Eindcontrole: `npm run verify` — build, syntaxcontrole, ESLint en 35 tests geslaagd.
- Nieuwe dekking: late afronding, overslaan, exacte datumselectie, ontbrekende uitvoeringen, vooruit afronden, heropenen, deactiveren, proces/rol-overerving, proceshernoeming, KPI, lange dagelijkse reeks, ongeldige datums, organisatiegrenzen, modulerechten, auditrelaties en het echte HTML-contract van het afrondvenster.
- Browsercontrole met synthetische gegevens: inloggen, jaarplanning, april afronden terwijl maart open blijft, opvolgactie aanmaken, terugvinden in procesbundel en My Tasks. De planning veranderde van 1 afgerond / 6 achterstallig / 1 overgeslagen naar 2 / 5 / 1.
- Alle databasecontroles gebruiken PGlite in het geheugen; de testconfiguratie blokkeert echte PostgreSQL- en externe netwerkverbindingen.

## Gedragsafspraken en technische grenzen

`/api/yearly` groepeert `completedDates` voortaan op **scheduled_date**. Het resultaat
bevat ook `instance_id`, `status`, `scheduled_date`, `completed_at` en notities.
Dit is bewust: het jaaroverzicht beantwoordt welke geplande controles zijn uitgevoerd.
Het Task Log blijft de werkelijke afrondingsdatum tonen.

De kalenderberekening is gedeeld via `src/server/services/task-schedule.js`.
Het aanmaken van ontbrekende uitvoeringen gebeurt in één organisatietransactie.
Een reeks wordt begrensd op 20.000 doorlopen datums; overschrijding geeft een fout
in plaats van een stilzwijgend onvolledige planning. Expliciete datumvragen zijn
begrensd tot tien kalenderjaren vooruit. Het bestaande maximum van 2.000 resultaten
per Task Log-aanvraag blijft gelden.

## Resterend vervolgwerk

- Wijzigingen van een herhalingsschema met bestaande historie hebben nog geen expliciete ingangsdatum of schemaversies. De huidige combinatie van nieuwe projectie en bestaande uitvoeringen kan dan extra plandatums tonen. Hiervoor is een afzonderlijk ontwerp voor herplannen en behoud van auditgeschiedenis nodig.
- Taken verwijzen nog op naam naar processen en rollen. Een migratie naar vaste proces- en rol-ID's zou ook rolhernoemingen en dubbele namen structureel oplossen.
- Historische vervolgacties zonder procesverwijzing worden niet met terugwerkende kracht gewijzigd.
- Geen echte PostgreSQL-concurrentie-/belastingtest, cloudopslagtest of productiecontrole uitgevoerd.

## Gecombineerde beveiligingsrelease

De planningswijzigingen zijn voor productie gecombineerd met beveiligingsrelease
`58a83a6` (PR #102) in `codex/combined-production-release`. De centrale
moduleautorisatie, alleen-lezenrechten, sessiecontrole, TLS-verificatie en
productiemigratiemarker blijven behouden. Het tekstconflict in de herstelhandleiding
is opgelost met behoud van het beveiligde herstelpad.

- `npm run verify`: build, syntax, ESLint en **44 tests geslaagd**.
- Aanvullende combinatietest: een ops-gebruiker kan een uitvoering afronden en ziet
  de juiste taaknaam/verantwoordelijke in Mission Control; verborgen modules blijven
  afgeschermd en een viewer kan geen uitvoering afronden, overslaan of heropenen.
- Browsercontrole op de gecombineerde versie met synthetische PGlite-data: login,
  jaarplanning, afronden van 30 april met notities en correct bijgewerkte tellers
  (2 afgerond / 5 achterstallig / 1 overgeslagen); 31 maart blijft open.

Deze aanvullende release wijzigt geen databaseschema, inloggegevens of
hostingvariabelen. Gebruik bij een planningsregressie een normale Git-revert van
alleen de planningsrelease, zodat de beveiligingsrelease behouden blijft.
De live uitrol en controle worden afzonderlijk vastgelegd in het releaseverslag.
