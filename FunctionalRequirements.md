# Product Requirements Document (PRD)
## Clone funzionale di una piattaforma di literature discovery interconnessa

## 1. Scopo del documento

Questo documento definisce i **requisiti funzionali** di una piattaforma di esplorazione, scoperta, organizzazione e raccomandazione di letteratura scientifica interconnessa, concepita come clone funzionale di strumenti di literature discovery visuale.

Il documento è destinato a un agente software incaricato di implementare il prodotto.

### Vincoli di questo documento
- Questo documento definisce **solo requisiti funzionali**.
- Questo documento **non** definisce stack tecnologico, architettura, librerie, framework, database, infrastruttura, modelli ML specifici o scelte implementative.
- Ogni decisione tecnica deve essere derivata successivamente dall’implementatore, purché rispetti integralmente i requisiti qui definiti.

---

## 2. Obiettivo del prodotto

Il prodotto deve consentire a un utente di:

- creare e gestire collezioni di articoli scientifici;
- aggiungere articoli a partire da identificatori, ricerche o importazioni;
- esplorare relazioni tra paper, autori, citazioni, similarità e temi;
- ricevere suggerimenti e raccomandazioni spiegabili;
- visualizzare l’evoluzione temporale di una linea di ricerca;
- fornire feedback esplicito che influenzi le raccomandazioni successive;
- annotare, taggare e tracciare lo stato di lettura dei paper;
- condividere collezioni con altri utenti;
- importare ed esportare dati bibliografici;
- interoperare con provider esterni di metadati bibliografici.

---

## 3. Ambito funzionale

Il sistema deve coprire i seguenti macro-moduli funzionali:

1. autenticazione e gestione identità;
2. gestione collezioni;
3. ricerca bibliografica;
4. inserimento paper;
5. deduplica e riconciliazione record;
6. esplorazione relazionale;
7. raccomandazioni e discovery;
8. timeline ed evoluzione temporale;
9. gestione autori;
10. annotazioni, tag e stato di lettura;
11. import/export;
12. sincronizzazione con provider esterni;
13. collaborazione e condivisione;
14. feed di aggiornamenti;
15. audit trail e cronologia;
16. privacy e controllo utente;
17. gestione errori e stati degradati.

---

## 4. Attori

### 4.1 Utente anonimo
Può:
- accedere a eventuali pagine pubbliche;
- registrarsi;
- autenticarsi.

Non può:
- creare dati persistenti personali;
- creare collezioni;
- salvare paper;
- usare personalizzazione persistente.

### 4.2 Utente autenticato
Può:
- creare e gestire collezioni;
- cercare e salvare paper;
- annotare;
- ricevere raccomandazioni personalizzate;
- importare/esportare dati;
- configurare preferenze;
- collegare provider esterni;
- condividere contenuti secondo i permessi previsti.

### 4.3 Collaboratore invitato
Può, in base ai permessi:
- visualizzare collezioni condivise;
- aggiungere o rimuovere paper;
- aggiungere note;
- interagire con contenuti condivisi.

### 4.4 Proprietario collezione
Può:
- condividere o revocare accessi;
- modificare permessi;
- controllare visibilità;
- gestire impostazioni di collezione.

### 4.5 Amministratore di sistema
Può:
- monitorare lo stato generale del sistema;
- gestire errori sistemici e abuso;
- moderare eventuali contenuti pubblici.

---

## 5. Entità funzionali

### 5.1 Paper
Ogni paper deve poter includere, se disponibile:

- identificatore interno univoco;
- DOI;
- titolo;
- sottotitolo;
- abstract;
- lista autori;
- affiliazioni;
- venue;
- anno;
- data di pubblicazione;
- tipo di pubblicazione;
- riferimenti bibliografici;
- citazioni ricevute;
- parole chiave;
- campi disciplinari;
- URL canonico;
- URL PDF;
- identificatori esterni;
- lingua;
- stato di completezza;
- stato di affidabilità;
- stato di eventuale retraction/correction, se noto;
- timestamp di aggiornamento.

Il sistema deve supportare paper con metadati incompleti, parziali o confliggenti.

### 5.2 Autore
Ogni autore deve poter includere:
- identificatore interno;
- nome canonico;
- alias o varianti;
- identificatori esterni, se disponibili;
- paper associati;
- coautori;
- aree tematiche prevalenti;
- affiliazioni, se disponibili.

### 5.3 Collezione
Ogni collezione deve includere:
- identificatore univoco;
- nome;
- descrizione;
- proprietario;
- visibilità;
- membri e permessi;
- lista paper;
- tag;
- note;
- cronologia attività.

### 5.4 Relazione
Il sistema deve rappresentare almeno le seguenti relazioni:
- paper cita paper;
- paper è citato da paper;
- paper è semanticamente simile a paper;
- autore ha scritto paper;
- autore collabora con autore;
- paper appartiene a collezione;
- paper appartiene a topic;
- topic è collegato a topic;
- paper è salvato/ignorato/escluso da utente.

### 5.5 Nota
Una nota deve poter essere associata a:
- paper;
- autore;
- collezione;
- suggerimento.

La nota deve supportare:
- testo libero;
- autore della nota;
- timestamp;
- modifica successiva;
- storico funzionale.

### 5.6 Feedback utente
Il sistema deve supportare feedback espliciti tra cui:
- salva;
- da leggere;
- in lettura;
- letto;
- importante;
- preferito;
- non rilevante;
- nascondi;
- ignorato;
- escluso;
- segui autore;
- non seguire autore;
- segui topic;
- non seguire topic;
- più come questo;
- meno come questo.

---

## 6. Regole globali di comportamento

### 6.1 Deduplica preventiva
Prima di creare un nuovo record paper, il sistema deve tentare di verificare se esiste già un record equivalente o altamente compatibile.

### 6.2 Gestione dati incompleti
Il sistema non deve bloccare l’uso di un paper solo perché i metadati sono incompleti, purché esista un record minimo valido.

### 6.3 Degradazione controllata
Se una funzione dipende da provider esterni o da metadati non disponibili, il sistema deve degradare in modo esplicito e comprensibile, senza perdere dati utente.

### 6.4 Persistenza dei dati utente
Note, tag, stati di lettura e feedback non devono andare persi a causa di aggiornamenti di metadati o merge di record.

### 6.5 Spiegabilità
Ogni raccomandazione, collegamento o deduplica rilevante deve essere spiegabile all’utente con una motivazione leggibile.

### 6.6 Controllo utente
L’utente deve poter modificare, revocare, correggere, nascondere o riesaminare azioni automatiche rilevanti che impattano la propria esperienza.

---

## 7. Functional Requirements

# 7.1 Autenticazione e identità

### FR-001 Registrazione
Il sistema deve consentire la registrazione di nuovi utenti.

### FR-002 Login
Il sistema deve consentire il login di utenti registrati.

### FR-003 Logout
Il sistema deve consentire il logout.

### FR-004 Recupero accesso
Il sistema deve consentire il recupero dell’accesso in caso di credenziali perse.

### FR-005 Gestione profilo
Il sistema deve consentire la visualizzazione e modifica del proprio profilo utente.

### FR-006 Identity federation
Il sistema deve poter supportare login tramite provider esterni, ove previsti dal prodotto.

### FR-007 Merge identità
Il sistema deve poter gestire casi in cui uno stesso utente abbia più identità potenzialmente unificabili, previa conferma esplicita.

#### Edge cases
- email già registrata;
- account non verificato;
- credenziali errate;
- sessione scaduta;
- provider esterno indisponibile;
- account duplicati tramite login federato;
- utente disabilitato.

---

# 7.2 Gestione collezioni

### FR-008 Creazione collezione
Il sistema deve consentire a un utente autenticato di creare una nuova collezione.

### FR-009 Collezione vuota o da seed
Il sistema deve consentire di creare una collezione sia vuota sia a partire da uno o più paper seed.

### FR-010 Rinomina collezione
Il sistema deve consentire di rinominare una collezione.

### FR-011 Descrizione collezione
Il sistema deve consentire di aggiungere o modificare una descrizione della collezione.

### FR-012 Archiviazione collezione
Il sistema deve consentire di archiviare una collezione senza distruggerne i dati.

### FR-013 Eliminazione collezione
Il sistema deve consentire l’eliminazione di una collezione previa conferma esplicita.

### FR-014 Duplicazione collezione
Il sistema deve consentire di duplicare una collezione preservandone contenuti e struttura logica.

### FR-015 Merge collezioni
Il sistema deve consentire di unire due o più collezioni preservando note, tag e stati dei paper.

### FR-016 Ordinamento e filtro
Il sistema deve consentire ordinamento e filtro dei paper all’interno di una collezione.

### FR-017 Tag di collezione
Il sistema deve consentire l’aggiunta di tag alla collezione.

### FR-018 Note di collezione
Il sistema deve consentire note a livello di collezione.

### FR-019 Snapshot di vista
Il sistema deve consentire di salvare uno stato di esplorazione come snapshot funzionale della collezione.

#### Edge cases
- collezione vuota;
- collezione con migliaia di paper;
- merge con conflitti;
- rinomina simultanea da utenti multipli;
- collezione condivisa con permessi che cambiano durante una modifica.

---

# 7.3 Inserimento paper

### FR-020 Aggiunta da DOI
Il sistema deve consentire di aggiungere un paper inserendo un DOI.

### FR-021 Aggiunta da titolo
Il sistema deve consentire di aggiungere un paper inserendo un titolo.

### FR-022 Aggiunta da URL
Il sistema deve consentire di aggiungere un paper a partire da un URL.

### FR-023 Aggiunta da ricerca
Il sistema deve consentire di aggiungere un paper dai risultati di ricerca.

### FR-024 Aggiunta da suggerimenti
Il sistema deve consentire di aggiungere un paper da suggerimenti o raccomandazioni.

### FR-025 Aggiunta da vista relazionale
Il sistema deve consentire di aggiungere un paper direttamente da grafo, timeline o viste di relazione.

### FR-026 Aggiunta da autore
Il sistema deve consentire di aggiungere paper dalla pagina autore.

### FR-027 Creazione manuale record minimo
Se un paper non è reperibile presso sorgenti esterne, il sistema deve consentire la creazione manuale di un record minimo.

### FR-028 Riconciliazione futura record manuale
Un record creato manualmente deve poter essere successivamente riconciliato con un record esterno.

#### Edge cases
- DOI invalido;
- DOI valido ma non risolvibile;
- titolo ambiguo;
- URL non parsabile;
- preprint vs journal;
- metadata mancanti;
- record duplicati;
- lingua diversa;
- stesso paper con titoli leggermente diversi.

---

# 7.4 Ricerca bibliografica

### FR-029 Ricerca per metadati
Il sistema deve consentire ricerca per titolo, autore, DOI, venue, anno e identificatori esterni.

### FR-030 Ricerca per abstract o testo disponibile
Il sistema deve consentire ricerca testuale nei campi disponibili.

### FR-031 Ricerca per topic e parole chiave
Il sistema deve consentire ricerca per parole chiave, topic e campi disciplinari se presenti.

### FR-032 Ricerca entro collezione
Il sistema deve consentire di limitare la ricerca a una specifica collezione.

### FR-033 Ricerca per stato utente
Il sistema deve consentire ricerca e filtro per stato di lettura, salvataggio, esclusione o tag.

### FR-034 Filtri avanzati
Il sistema deve consentire combinazioni di filtri avanzati.

### FR-035 Ordinamento risultati
Il sistema deve consentire l’ordinamento dei risultati per rilevanza, data, citazioni, novità o altri criteri funzionali disponibili.

### FR-036 Suggerimenti query
Il sistema deve fornire suggerimenti/autocomplete durante l’inserimento di query.

### FR-037 Tolleranza ad errori minori
Il sistema deve supportare ricerca tollerante a piccoli errori di battitura.

### FR-038 Disambiguazione autori
Il sistema deve supportare la disambiguazione di autori omonimi.

### FR-039 Evidenziazione presenza già nota
Il sistema deve evidenziare se un paper nei risultati è già presente in una o più collezioni dell’utente.

#### Edge cases
- query vuota;
- query troppo generica;
- query con caratteri speciali;
- risultati eccessivi;
- paper senza abstract;
- autori con varianti di nome;
- venue con nomi cambiati nel tempo.

---

# 7.5 Deduplica e riconciliazione

### FR-040 Rilevamento candidati duplicati
Il sistema deve identificare candidati duplicati sulla base di identificatori, titolo, autori, anno, venue o combinazioni di segnali.

### FR-041 Deduplica automatica con confidenza alta
Il sistema deve poter evitare la creazione di duplicati quando la confidenza di equivalenza è sufficientemente alta.

### FR-042 Revisione manuale casi ambigui
Il sistema deve richiedere disambiguazione o revisione nei casi dubbi.

### FR-043 Conservazione dati utente nel merge
In caso di merge, note, tag, stati di lettura e cronologia devono essere preservati.

### FR-044 Consolidamento identificatori
In caso di merge, gli identificatori esterni devono essere consolidati in un record unico.

### FR-045 Tracciabilità del merge
Il sistema deve rendere visibile che è avvenuto un merge.

### FR-046 Revisione/annullamento merge manuale
Per merge non completamente automatici o confermati manualmente, il sistema deve supportare revisione o annullamento funzionale.

### FR-047 Distinzione tra versioni realmente diverse
Il sistema non deve fondere automaticamente senza adeguata confidenza:
- preprint e versione journal;
- conference e journal extension;
- correction/erratum e articolo originale;
- traduzioni;
- lavori distinti con titolo simile.

---

# 7.6 Esplorazione relazionale

### FR-048 Vista relazionale dei paper
Il sistema deve consentire la visualizzazione delle relazioni tra paper.

### FR-049 Tipi di relazione
La vista relazionale deve distinguere almeno:
- citazioni;
- lavori citati;
- lavori citanti;
- similarità;
- relazione autore-paper;
- relazione coautore;
- appartenenza a collezione;
- relazione con topic.

### FR-050 Espansione progressiva
L’utente deve poter espandere un nodo per esplorare ulteriori relazioni.

### FR-051 Collasso sottografi
L’utente deve poter collassare un insieme di nodi o relazioni.

### FR-052 Focus su nodo seed
L’utente deve poter fissare uno o più nodi come seed dell’esplorazione.

### FR-053 Cambio focus
L’utente deve poter cambiare il focus dell’esplorazione selezionando un altro nodo.

### FR-054 Filtri su nodi
L’utente deve poter filtrare i nodi per tipo, periodo, rilevanza o stato.

### FR-055 Filtri su archi
L’utente deve poter filtrare gli archi per tipo di relazione.

### FR-056 Controllo della profondità
L’utente deve poter limitare la profondità di espansione.

### FR-057 Controllo della densità
L’utente deve poter limitare il numero di nodi/relazioni mostrati.

### FR-058 Blocco nodi
L’utente deve poter fissare nodi nella vista.

### FR-059 Nascondi nodi
L’utente deve poter nascondere nodi non rilevanti.

### FR-060 Salvataggio stato vista
Il sistema deve consentire il salvataggio dello stato della vista relazionale.

### FR-061 Azioni dirette dalla vista
L’utente deve poter aggiungere, salvare, escludere o annotare paper direttamente dalla vista relazionale.

#### Edge cases
- grafi molto densi;
- cicli;
- riferimenti mancanti;
- relazioni inferite e non certe;
- paper isolati;
- nodi duplicati;
- archi confliggenti tra fonti.

---

# 7.7 Raccomandazioni e discovery

### FR-062 Raccomandazioni da paper seed
Il sistema deve generare raccomandazioni a partire da uno o più paper seed.

### FR-063 Raccomandazioni da collezione
Il sistema deve generare raccomandazioni a partire dal contenuto di una collezione.

### FR-064 Raccomandazioni da cronologia e feedback
Il sistema deve generare raccomandazioni basate sulle interazioni dell’utente.

### FR-065 Raccomandazioni da autori e topic seguiti
Il sistema deve generare suggerimenti a partire da autori o topic seguiti.

### FR-066 Tipologie minime di raccomandazione
Il sistema deve supportare almeno:
- paper simili;
- paper precedenti rilevanti;
- paper successivi rilevanti;
- lavori recenti su topic;
- lavori fondamentali mancanti;
- autori correlati;
- collegamenti tra aree d’interesse.

### FR-067 Motivazione della raccomandazione
Ogni raccomandazione deve esporre una motivazione leggibile.

### FR-068 Feedback esplicito sui suggerimenti
L’utente deve poter salvare, ignorare, escludere, nascondere o raffinare i suggerimenti.

### FR-069 Controlli di esclusione
L’utente deve poter escludere autori, anni, venue, topic o categorie di risultati.

### FR-070 Controlli temporali
L’utente deve poter restringere raccomandazioni ai soli lavori recenti o a determinati intervalli temporali.

### FR-071 Controlli di copertura
L’utente deve poter limitare suggerimenti ai lavori maggiormente collegati, oppure favorire lavori emergenti o meno noti, se supportato a livello funzionale.

### FR-072 Riduzione ripetizioni
Il sistema deve evitare di riproporre in modo aggressivo suggerimenti già ignorati o esclusi.

### FR-073 Gestione cold start
Il sistema deve supportare scenari di cold start con pochi o nessun segnale utente.

### FR-074 Adattamento al feedback
I suggerimenti successivi devono essere influenzati dal feedback esplicito e implicito.

#### Edge cases
- cold start totale;
- collezione con un solo paper;
- collezione eterogenea;
- feedback contraddittorio;
- bias verso paper molto citati;
- bias verso paper recenti;
- suggerimenti dominati da un autore o venue;
- paper recenti con poche citazioni;
- loop di raccomandazione.

---

# 7.8 Timeline ed evoluzione temporale

### FR-075 Timeline di collezione
Il sistema deve consentire la visualizzazione temporale dei paper di una collezione.

### FR-076 Timeline di topic o seed
Il sistema deve consentire la visualizzazione temporale di un topic o di un sottografo derivato da un seed.

### FR-077 Filtri temporali
L’utente deve poter filtrare per intervalli temporali.

### FR-078 Individuazione di lavori seminali e recenti
Il sistema deve consentire di distinguere lavori originari, intermedi e recenti.

### FR-079 Evoluzione del filone
Il sistema deve consentire di osservare la progressione temporale di un filone di ricerca.

### FR-080 Individuazione di fasi di crescita
Il sistema deve consentire di individuare periodi di accelerazione o densificazione di una linea di ricerca.

#### Edge cases
- data mancante;
- solo anno disponibile;
- online first vs versione finale;
- date discordanti;
- preprint precedente alla versione ufficiale;
- errori di ordinamento temporale.

---

# 7.9 Gestione autori

### FR-081 Ricerca autore
Il sistema deve consentire la ricerca di autori.

### FR-082 Profilo autore
Il sistema deve fornire una vista autore con paper, coautori e collegamenti rilevanti.

### FR-083 Navigazione coautori
Il sistema deve consentire di esplorare reti di coautorship.

### FR-084 Follow/unfollow autore
L’utente deve poter seguire o smettere di seguire un autore.

### FR-085 Suggerimento autori correlati
Il sistema deve poter suggerire autori correlati a un autore, collezione o topic.

### FR-086 Disambiguazione autori
Il sistema deve gestire autori omonimi e profili potenzialmente ambigui.

#### Edge cases
- autore con nome abbreviato;
- varianti di nome;
- cambio cognome;
- translitterazioni;
- paper assegnati all’autore sbagliato;
- autori collettivi.

---

# 7.10 Stato di lettura, tagging e workflow personale

### FR-087 Stati utente
Il sistema deve consentire almeno i seguenti stati:
- non visto;
- visto;
- salvato;
- da leggere;
- in lettura;
- letto;
- importante;
- ignorato;
- escluso.

### FR-088 Stato globale e per collezione
Il sistema deve poter distinguere tra stato globale del paper per utente e stato locale rispetto a una collezione.

### FR-089 Filtri per stato
Il sistema deve consentire filtri per stato.

### FR-090 Tag personalizzati
Il sistema deve consentire tag personalizzati ai paper.

### FR-091 Ricerca per tag
Il sistema deve consentire ricerca o filtro per tag.

### FR-092 Riduzione riproposizione paper esclusi
Il sistema deve ridurre la riproposizione di paper marcati come esclusi o ignorati.

### FR-093 Evidenziazione non ancora esaminati
Il sistema deve permettere di identificare paper non ancora esaminati all’interno di una rete o collezione.

#### Edge cases
- stesso paper in più collezioni con stati diversi;
- conflitto tra stato manuale e stato derivato;
- marcatura accidentale come letto;
- aggiornamenti non sincronizzati.

---

# 7.11 Note e annotazioni

### FR-094 Note su paper
Il sistema deve consentire di aggiungere note a un paper.

### FR-095 Note su autore
Il sistema deve consentire di aggiungere note a un autore.

### FR-096 Note su collezione
Il sistema deve consentire note a livello di collezione.

### FR-097 Modifica note
Il sistema deve consentire di modificare note esistenti.

### FR-098 Storico note
Il sistema deve mantenere uno storico funzionale delle modifiche.

### FR-099 Ricerca nelle note
Il sistema deve consentire ricerca nelle note.

### FR-100 Persistenza note attraverso merge o update
Le note devono restare associate al record logico corretto anche dopo merge o aggiornamenti metadati.

#### Edge cases
- due utenti modificano la stessa nota;
- merge di record annotati;
- paper rimosso dalla collezione ma con note persistenti;
- riferimenti nelle note verso elementi rimossi.

---

# 7.12 Import

### FR-101 Import da identificatori
Il sistema deve supportare import da DOI singoli o multipli e altri identificatori supportati.

### FR-102 Import da liste di titoli
Il sistema deve supportare import da liste di titoli.

### FR-103 Import da file bibliografici
Il sistema deve supportare import da formati bibliografici standard previsti dal prodotto.

### FR-104 Import da export di reference manager
Il sistema deve supportare import da esportazioni di reference manager esterni, ove i formati siano compatibili.

### FR-105 Import da URL
Il sistema deve supportare import a partire da URL di articoli o record.

### FR-106 Preview import
Il sistema deve fornire una preview dell’import.

### FR-107 Deduplica durante import
Il sistema deve deduplicare i record durante la procedura di import.

### FR-108 Correzione mapping
Il sistema deve consentire correzione o revisione dei record problematici.

### FR-109 Continuità dell’import
Il sistema deve consentire di proseguire l’import anche se alcuni record falliscono.

### FR-110 Report finale
Il sistema deve produrre un report funzionale dell’import con successi, duplicati, record problematici e record saltati.

#### Edge cases
- file malformato;
- encoding errato;
- record duplicati nello stesso file;
- campi mancanti;
- import molto grande;
- interruzione a metà;
- retry parziale.

---

# 7.13 Export

### FR-111 Export collezione
Il sistema deve consentire l’export di una collezione.

### FR-112 Export selettivo
Il sistema deve consentire export filtrato o parziale.

### FR-113 Export metadata
Il sistema deve consentire export dei metadata dei paper.

### FR-114 Export note e stati
Il sistema deve consentire export di note, tag e stati, se richiesto.

### FR-115 Export in formati standard
Il sistema deve supportare export in formati bibliografici standard previsti dal prodotto.

### FR-116 Export completo di backup
Il sistema deve supportare un export strutturato completo dei dati utente, per quanto previsto dal modello di prodotto.

### FR-117 Preservazione identificatori
L’export deve preservare gli identificatori esterni noti.

#### Edge cases
- campi non mappabili nei formati standard;
- caratteri speciali;
- dati parziali;
- collezioni molto grandi;
- note private da includere o escludere.

---

# 7.14 Integrazione con provider esterni

### FR-118 Astrazione provider esterni
Il sistema deve supportare integrazione con provider esterni di metadati bibliografici tramite un livello funzionale astratto.

### FR-119 Lookup identificatori
Il sistema deve poter interrogare provider esterni a partire da DOI o altri identificatori.

### FR-120 Ricerca paper esterna
Il sistema deve poter utilizzare provider esterni per ricerca metadati.

### FR-121 Recupero relazioni
Il sistema deve poter recuperare, ove disponibile, riferimenti, citazioni, autori, venue, abstract e altri metadati.

### FR-122 Supporto autenticazione provider
Il sistema deve poter supportare provider che richiedono API key, token o credenziali applicative.

### FR-123 Gestione credenziali
Il sistema deve prevedere la gestione funzionale di credenziali richieste dai provider.

### FR-124 Gestione assenza credenziali
Il sistema deve distinguere i casi in cui una funzione non è disponibile per mancanza, scadenza o quota esaurita delle credenziali.

### FR-125 Fallback tra provider
Il sistema deve poter usare più provider con fallback o priorità logica.

### FR-126 Riconciliazione tra fonti
Il sistema deve poter riconciliare metadati confliggenti provenienti da fonti diverse.

### FR-127 Tolleranza a rate limit e outage
Il sistema deve gestire stati di rate limit, indisponibilità temporanea o risposta parziale dei provider.

### FR-128 Visibilità dipendenze funzionali
Il sistema deve poter dichiarare, a livello funzionale, quali feature dipendono da quali provider.

#### Requisito documentale per ogni provider
Per ogni provider integrato devono essere definiti:
- nome del provider;
- dati ottenibili;
- identificatori supportati;
- necessità o meno di API key o token;
- tipo di credenziale;
- limiti funzionali noti;
- comportamento in assenza di credenziale;
- priorità di fiducia rispetto ad altre fonti.

#### Edge cases
- provider down;
- schema cambiato;
- dati parziali;
- mismatch tra provider;
- quota superata;
- token scaduto;
- stesso paper presente solo in una fonte.

---

# 7.15 Sync con reference manager o librerie esterne

### FR-129 Collegamento libreria esterna
Il sistema deve poter collegare una libreria esterna se il prodotto lo prevede.

### FR-130 Import iniziale da libreria
Il sistema deve supportare un import iniziale dei contenuti della libreria collegata.

### FR-131 Sync incrementale
Il sistema deve poter sincronizzare modifiche successive.

### FR-132 Mapping ID esterni/interni
Il sistema deve mantenere mapping tra identificatori interni ed esterni.

### FR-133 Riconciliazione modifiche
Il sistema deve gestire conflitti tra stato locale e stato esterno.

### FR-134 Deduplica in sync
Il sistema deve evitare la creazione di duplicati durante la sincronizzazione.

### FR-135 Gestione autorizzazione revocata
Il sistema deve gestire in modo esplicito il caso in cui l’autorizzazione al provider esterno venga revocata.

#### Edge cases
- elemento rimosso nella sorgente esterna ma annotato localmente;
- sync interrotta;
- titolo cambiato nella fonte;
- libreria collegata due volte;
- credenziali revocate.

---

# 7.16 Feed e aggiornamenti

### FR-136 Feed di novità
Il sistema deve generare un feed di aggiornamenti bibliografici rilevanti.

### FR-137 Feed per collezione
Il sistema deve poter mostrare nuovi paper rilevanti per una collezione.

### FR-138 Feed per autore o topic seguito
Il sistema deve poter mostrare aggiornamenti per autori o topic seguiti.

### FR-139 Distinzione tipi di aggiornamento
Il feed deve distinguere almeno:
- nuovi lavori;
- lavori recentemente rilevanti;
- lavori di autori seguiti;
- estensioni di filoni seguiti;
- collegamenti tra aree seguite.

### FR-140 Azioni dal feed
L’utente deve poter salvare, ignorare, escludere o approfondire elementi del feed.

#### Edge cases
- feed vuoto;
- feed rumoroso;
- duplicati nel feed;
- reintroduzione di paper già esclusi;
- date incoerenti.

---

# 7.17 Collaborazione e condivisione

### FR-141 Visibilità collezioni
Il sistema deve supportare collezioni private, condivise e, se previsto dal prodotto, pubbliche.

### FR-142 Invito collaboratori
Il sistema deve consentire di invitare collaboratori.

### FR-143 Ruoli minimi
Il sistema deve supportare almeno i ruoli:
- owner;
- editor;
- viewer.

### FR-144 Revoca accesso
Il sistema deve consentire la revoca di accessi.

### FR-145 Permessi differenziati
Il sistema deve applicare i permessi coerentemente alle azioni possibili.

### FR-146 Cronologia modifiche collaborative
Il sistema deve rendere consultabile la cronologia delle modifiche rilevanti in una collezione condivisa.

### FR-147 Distinzione contenuti privati e condivisi
Se il prodotto lo prevede, il sistema deve distinguere note private da note condivise.

#### Edge cases
- utente rimosso durante modifica;
- invito a utente inesistente;
- cambio visibilità accidentale;
- conflitti di modifica simultanea.

---

# 7.18 Notifiche

### FR-148 Notifiche di nuovi suggerimenti
Il sistema deve poter notificare nuovi suggerimenti rilevanti.

### FR-149 Notifiche di aggiornamenti condivisi
Il sistema deve poter notificare aggiornamenti in collezioni condivise.

### FR-150 Notifiche di import/sync
Il sistema deve poter notificare completamento, errore o stato anomalo di importazioni o sincronizzazioni.

### FR-151 Configurazione notifiche
L’utente deve poter controllare tipologia, frequenza e canale delle notifiche, secondo le opzioni previste dal prodotto.

### FR-152 Silenziamento
L’utente deve poter silenziare o limitare le notifiche.

#### Edge cases
- burst di notifiche;
- eventi duplicati;
- evento non più valido;
- preferenze non configurate.

---

# 7.19 Personalizzazione

### FR-153 Uso dei segnali utente
Il sistema deve poter utilizzare segnali espliciti e impliciti per personalizzare suggerimenti e feed.

### FR-154 Esclusione di collezioni dalla personalizzazione
L’utente deve poter escludere una o più collezioni dal profilo di personalizzazione.

### FR-155 Reset o attenuazione personalizzazione
L’utente deve poter resettare o attenuare la personalizzazione.

### FR-156 Evitare feedback loops eccessivi
Il sistema deve ridurre l’effetto di chiusura eccessiva del profilo raccomandativo.

### FR-157 Trasparenza minima
Il sistema deve rendere comprensibile che un suggerimento è stato influenzato dal comportamento utente.

---

# 7.20 Audit trail e cronologia

### FR-158 Logging funzionale eventi utente
Il sistema deve registrare eventi funzionali rilevanti, tra cui:
- creazione/eliminazione collezioni;
- aggiunta/rimozione paper;
- merge di record;
- cambio stati;
- note;
- import/export;
- condivisioni;
- feedback sui suggerimenti.

### FR-159 Distinzione tra eventi automatici e manuali
La cronologia deve distinguere eventi compiuti dall’utente da quelli eseguiti automaticamente.

### FR-160 Consultazione cronologia
Il sistema deve consentire all’utente di consultare almeno in forma sintetica la cronologia rilevante.

---

# 7.21 Privacy e controllo utente

### FR-161 Controllo visibilità
L’utente deve poter controllare la visibilità di profilo, collezioni e contenuti condivisibili.

### FR-162 Controllo uso dati per personalizzazione
L’utente deve poter controllare se e come i propri dati influenzano la personalizzazione.

### FR-163 Collegamento e scollegamento provider
L’utente deve poter collegare o scollegare provider esterni.

### FR-164 Export dati personali
L’utente deve poter esportare i propri dati.

### FR-165 Eliminazione account
Il sistema deve supportare l’eliminazione dell’account secondo le regole del prodotto.

### FR-166 Gestione dati dopo eliminazione account
Il sistema deve gestire cosa accade ai contenuti condivisi o alle collezioni in caso di eliminazione dell’account.

#### Edge cases
- owner eliminato con collezioni condivise attive;
- provider scollegato con dati già importati;
- consenso revocato dopo uso prolungato.

---

# 7.22 Gestione errori e stati degradati

### FR-167 Nessun risultato
Il sistema deve gestire in modo esplicito le ricerche senza risultati.

### FR-168 Errore provider esterno
Il sistema deve gestire l’indisponibilità di provider esterni senza perdita di dati utente.

### FR-169 Metadata parziali o inconsistenti
Il sistema deve rendere visibile quando i dati disponibili sono incompleti o potenzialmente incoerenti.

### FR-170 Import/export parziale
Il sistema deve segnalare chiaramente import/export parziali.

### FR-171 Raccomandazioni non disponibili
Il sistema deve gestire il caso in cui le raccomandazioni non possano essere generate temporaneamente.

### FR-172 Grafo troppo grande
Il sistema deve gestire il caso in cui una vista relazionale completa non possa essere resa integralmente.

### FR-173 Azioni recuperabili
Quando possibile, il sistema deve consentire retry, revisione o recupero dell’azione fallita.

### FR-174 Nessuna perdita silenziosa
Il sistema non deve perdere silenziosamente dati utente o azioni rilevanti.

---

## 8. Regole funzionali di qualità del record

### FR-175 Classificazione qualità record
Il sistema deve poter classificare un record come:
- completo;
- parziale;
- ambiguo;
- da verificare;
- manuale;
- deduplicato;
- corretto/ritirato, se noto.

### FR-176 Evidenziazione incertezza
Il sistema deve evidenziare i record incompleti o incerti.

### FR-177 Impatto della qualità sulle raccomandazioni
I record poco affidabili o incompleti non devono essere trattati indistintamente rispetto ai record affidabili.

### FR-178 Segnalazione errore record
L’utente deve poter segnalare un record errato o ambiguo.

---

## 9. Requisiti relativi alle API esterne e alle credenziali

Questo blocco non impone provider specifici, ma definisce requisiti funzionali che l’implementazione deve rispettare.

### FR-179 Supporto provider con e senza credenziali
Il sistema deve poter operare con provider che richiedano:
- nessuna autenticazione;
- API key;
- token OAuth;
- credenziali applicative;
- credenziali per utente;
- credenziali globali di sistema.

### FR-180 Distinzione credenziali per provider
Per ogni provider, il sistema deve sapere se la credenziale è:
- obbligatoria o opzionale;
- globale o per utente;
- necessaria per tutto il provider o solo per alcune funzionalità.

### FR-181 Stato delle credenziali
Il sistema deve poter distinguere tra:
- credenziale assente;
- credenziale valida;
- credenziale scaduta;
- credenziale invalida;
- quota esaurita.

### FR-182 Degradazione in assenza credenziali
In assenza di credenziali valide, il sistema deve chiarire quali funzionalità non sono disponibili e quali restano operative.

### FR-183 Documentazione funzionale delle dipendenze
Ogni dipendenza esterna deve essere descritta in termini di:
- dati forniti;
- funzionalità abilitate;
- requisiti di credenziale;
- limiti funzionali;
- fallback previsti.

---

## 10. Acceptance Criteria end-to-end

### AC-001 Seed to discovery
Dato un utente autenticato con una nuova collezione,
quando aggiunge uno o più paper seed,
allora il sistema deve:
- recuperare o creare i record bibliografici;
- mostrare relazioni con lavori precedenti, successivi e simili;
- consentire il salvataggio di nuovi paper;
- adattare i suggerimenti in base al feedback espresso.

### AC-002 Import and organize
Dato un utente che importa una libreria o file bibliografico,
quando l’import viene elaborato,
allora il sistema deve:
- identificare duplicati;
- segnalare record ambigui o incompleti;
- consentire correzione dei casi problematici;
- produrre una collezione organizzabile e filtrabile.

### AC-003 Explainable recommendation
Dato un suggerimento mostrato all’utente,
quando l’utente lo ispeziona,
allora il sistema deve poter spiegare perché è stato proposto.

### AC-004 Feedback loop control
Dato un paper marcato come escluso o non rilevante,
quando il sistema genera suggerimenti successivi,
allora tale paper non deve essere riproposto in modo aggressivo, salvo esplicita ragione o nuovo contesto rilevante.

### AC-005 Collaboration
Dato che una collezione è condivisa,
quando un collaboratore autorizzato modifica contenuti,
allora il proprietario deve poter visualizzare le modifiche nella cronologia e il sistema deve rispettare i permessi configurati.

### AC-006 Data preservation through merge
Dato che due record paper vengono fusi,
quando il merge è completato,
allora note, tag, stati utente e identificatori devono essere preservati nel record risultante.

### AC-007 Graceful degradation
Dato che un provider esterno non è disponibile,
quando l’utente tenta un’azione dipendente da tale provider,
allora il sistema deve degradare in modo esplicito, senza perdita di dati già presenti.

---

## 11. Hedge cases globali obbligatori

L’implementazione deve coprire obbligatoriamente almeno i seguenti casi limite.

### 11.1 Dati bibliografici
- DOI presente ma errato;
- DOI assente;
- DOI valido ma non risolvibile;
- titolo ambiguo;
- stesso titolo per lavori diversi;
- preprint vs journal;
- conference vs journal extension;
- paper corretto o ritirato;
- abstract mancante;
- riferimenti mancanti;
- citazioni mancanti;
- autori mancanti o in ordine diverso tra fonti;
- record duplicati cross-source;
- metadata con codifica errata;
- paper multilingua o con translitterazioni;
- anno noto ma data completa ignota.

### 11.2 Grafo e discovery
- paper isolato;
- paper iper-citato che inquina i suggerimenti;
- collezione troppo eterogenea;
- cold start;
- feedback contraddittorio;
- bias verso recenti;
- bias verso classici;
- ricomparsa di elementi esclusi;
- loop di raccomandazione;
- densità eccessiva del grafo.

### 11.3 Multiutente
- modifiche simultanee;
- perdita permessi durante editing;
- note private in collezioni condivise;
- merge di record annotati da più utenti;
- cancellazione proprietario.

### 11.4 Provider esterni
- rate limit;
- token scaduto;
- provider down;
- schema cambiato;
- dati parziali;
- conflitto tra provider;
- provider che restituisce lo stesso paper con metadata diversi.

### 11.5 Import/export/sync
- file corrotto;
- import grande;
- import interrotta;
- retry parziale;
- sync con conflitti;
- elemento rimosso nella fonte ma annotato localmente;
- stessa libreria collegata due volte.

---

## 12. Out of scope per questo documento

Questo documento non definisce:
- linguaggi di programmazione;
- framework frontend/backend;
- database;
- search engine specifico;
- provider bibliografici specifici;
- algoritmi di ranking o recommendation specifici;
- infrastruttura deployment;
- dettagli UI pixel-perfect;
- benchmark prestazionali;
- requisiti non funzionali di scalabilità, sicurezza o latenza.

Tali aspetti devono essere definiti separatamente in documenti tecnici successivi.

---

## 13. Istruzione finale per l’agente implementatore

Implementare una piattaforma di literature discovery interconnessa che soddisfi integralmente tutti i requisiti funzionali definiti in questo documento.

In particolare, il sistema deve:
- permettere gestione di collezioni di paper;
- consentire aggiunta paper da ricerca, identificatori, URL e import;
- supportare deduplica e riconciliazione robuste;
- offrire ricerca bibliografica flessibile;
- mostrare esplorazione relazionale tra paper, autori e topic;
- generare raccomandazioni spiegabili e adattive;
- supportare timeline temporali;
- consentire note, tag e stati di lettura;
- integrare provider esterni con gestione di credenziali e fallback;
- supportare collaborazione e condivisione;
- preservare dati utente in presenza di merge, sync ed errori;
- degradare correttamente in presenza di dati incompleti o dipendenze esterne non disponibili.

L’implementazione non deve introdurre vincoli che impediscano il rispetto dei requisiti sopra definiti.