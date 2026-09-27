# Collaudo locale Semantic Scholar — 26 settembre 2026

Branch: `codex/semantic-scholar-provider`. Nessun push, merge o Pull Request.

**Esito: controlli automatici locali superati e flussi applicativi verificati; collaudo live non interamente verde per HTTP 429 restituiti da Semantic Scholar.** Questa sessione successiva aggiorna il precedente record di validazione in [SemanticScholar.md](SemanticScholar.md): il precedente passaggio di tutti e tre i test live non implica che siano passati anche in questa esecuzione.

## Ambiente e isolamento

Applicazione Docker su http://localhost:3000; API su http://localhost:8000; email locali Mailpit su http://localhost:8025. Readiness finale: `status=ok`, `db=ok`, `cache=ok`.

Lo stack usa `openbib_semantic_scholar`, selezionato dal file locale ignorato `docker-compose.override.yml`. Il database preesistente `openbib` aveva una cronologia Alembic di un'altra versione; è stato preservato. Le migrazioni del branch sono applicate nel database separato. Il vecchio container orfano bibliography-worker resta fermo.

I test PostgreSQL/Redis hanno usato container temporanei separati, porte 15432/16379, poi rimossi. Nessuna suite distruttiva è stata eseguita sul database applicativo. Un account sintetico ha esercitato le API reali e la UI; account, raccolta, libreria, note e tag di collaudo sono stati eliminati tramite l'API a fine prova. È stata verificata anche la revoca della sessione. I messaggi sintetici di verifica possono restare in Mailpit. I dati dell'utente sono stati preservati.

## Comandi e risultati

Comandi backend dalla directory `backend`, frontend da `frontend`, con Node 24.

| Controllo | Esito di questa sessione |
| --- | --- |
| `.venv/bin/pytest -q` | 175 passati, 5 saltati: 2 PostgreSQL e 3 live |
| `.venv/bin/pytest -q`, con `TEST_DB_URL` e `TEST_REDIS_URL` isolati | 177 passati, 3 live saltati; incluse verifiche di concorrenza |
| `.venv/bin/python -m scripts.check_migrations`, con `MIGRATION_TEST_DATABASE_URL` isolato | Upgrade da zero e dal precedente head, round-trip cifratura, atomicità su fallimento: passati |
| `.venv/bin/ruff check .` | Passato |
| `.venv/bin/ruff format --check .` | 113 file conformi |
| `npm test -- --run` dopo la correzione UI | 94 test passati, 20 file |
| `npm run lint` | Passato |
| `npm run build` | TypeScript e Vite passati; resta l'avviso sui chunk oltre 500 kB |
| `RUN_SEMANTIC_SCHOLAR_LIVE=1 .venv/bin/pytest -m live -q -s` | 2 passati, 1 fallito per HTTP 429 upstream |
| Ripetizione del solo `test_live_titans_discovery_pipeline` | Ancora HTTP 429 sulla risoluzione arXiv; non nascosto né convertito in skip |
| `docker compose up -d --build --no-deps web` | Frontend corretto ricostruito e avviato |
| `git diff --check` | Passato |

## Prove reali sull'applicazione

Attraverso nginx, FastAPI, PostgreSQL, Redis e mail-worker reali:

- Registrazione sintetica, consegna email in Mailpit, verifica email, login, refresh e logout; sessione persistente dopo ricaricamento del browser.
- Ricerca Titans per titolo: provider dichiarato esclusivamente `semantic_scholar`, un solo risultato corrispondente al paper richiesto.
- Dettaglio: titolo, abstract, tre autori, DOI, arXiv e S2; alias DOI/S2/arXiv dell'applicazione risolti alla stessa chiave canonica. Queste richieste possono sfruttare i metadati già in cache e sono distinte dal test upstream diretto fallito.
- Libreria: doppio salvataggio idempotente, una sola voce e una sola versione.
- Raccolta: creazione privata, aggiunta del paper, duplicato respinto con 409; contenuto idratato e coerente con la libreria.
- Note, modifica nota, tag e stato di lettura; nel browser aggiunta una seconda nota e cambiato stato a Letto. Persistenza ricontrollata via API e nella raccolta.
- Grafi di libreria/raccolta e paper; espansione reale dei riferimenti di Titans nel browser: **11 nodi, 10 archi**. Il primo tentativo aveva restituito 503 dopo ripetuti 429 upstream; il successivo è riuscito.
- Esportazione dati dell'account sintetico.
- Isolamento anonimo: raccolta privata e relativo grafo negati, libreria 401.
- Provider disabilitato e pagina/stato non validi respinti con 422; dettaglio paper inesistente 404.
- Errore su grafo di raccolta inesistente visibile nel browser con pulsante Riprova.
- Nessun errore/warning JavaScript osservato nella pagina aggiornata durante la prova positiva del grafo.

## Problema trovato e corretto

`GraphPage` non mostrava gli errori del caricamento iniziale o dell'espansione: un limite del provider lasciava il grafo immutato senza spiegazione. Ora un messaggio persistente accessibile (`role=alert`) mostra l'errore e consente di riprovare. Un'espansione fallita conserva i nodi esistenti e ripete gli stessi parametri. Errori senza dettaglio testuale ricevono un messaggio italiano/inglese leggibile. Rimossi i tentativi automatici aggiuntivi dal caricamento base del grafo, perché il backend gestisce già retry e backoff.

File: `frontend/src/pages/GraphPage.tsx`, `GraphPage.css`, `frontend/src/i18n/locales/{en,it}.json`, `frontend/src/pages/__tests__/GraphPage.test.tsx`. Tre regressioni aggiunte: errore iniziale e recupero, errore di espansione con conservazione del grafo/riprova, dettaglio malformato con fallback leggibile.

## Titans e limiti della validazione live

S2: `5e7a795d89910634f001cc3a631023f1dd4e2e23`; DOI: `10.48550/arxiv.2501.00663`; arXiv: `2501.00663`.

In questa sessione sono passati i test live di riferimenti/citazioni, paginazione forzata dei riferimenti, entrambe le direzioni di espansione, unicità dei nodi e archi del grafo base, più il rifiuto di una chiave API volutamente non valida. Sono stati recuperati **130 identificatori unici di riferimenti utilizzabili**; il contatore del provider indica 135. La UI mostrava 341 citazioni. Contatori e numero di record risolvibili possono differire.

Il test live discovery ha ottenuto ricerca, lookup S2 e DOI, poi ha esaurito i retry sul lookup `ARXIV:2501.00663`. Anche il tentativo isolato successivo è fallito per 429. Pertanto il confronto completo dei tre percorsi e la paginazione della ricerca non risultano conclusi nel test live di questa sessione; erano passati nella precedente validazione e restano coperti con risposte simulate. Nessuna ulteriore ripetizione indefinita è stata avviata.

Semantic Scholar fornisce per Titans `publicationDate=2024-12-31` e `year=2025`. Il modello esistente privilegia la data precisa, per cui la UI mostra 2024: discrepanza dei metadati upstream già documentata, non perdita dell'identità del paper.

## Provider e credenziali

Nel processo di controllo eseguito dentro l'immagine API Docker, il registro istanzia solo Semantic Scholar; i moduli OpenAlex, Crossref, arXiv ed EuropePMC non sono importati. I quattro adapter sono invariati nel diff. Le richieste che cercano di abilitarli dall'API sono rifiutate. Normalizzazione, deduplicazione, cache ed errori sono coperti dalle suite.

La chiave reale è assente dai file tracciati/candidati e dai log QA controllati con confronto dei byte, senza stamparla. `.env` è ignorato e non tracciato; `docker-compose.override.yml` è ignorato. Chiave mancante e chiave non valida sono coperte rispettivamente da test isolati e anche dal test live di autenticazione.

## Verifiche successive per l'utente

Aprire http://localhost:3000 e creare un account nel database separato, usando Mailpit per la verifica. Provare una ricerca nuova, salvare paper, aggiungerli a raccolte ed espandere i grafi. Se Semantic Scholar limita le richieste, attendere prima di riprovare. Il comportamento sotto elevata concorrenza/multipli worker non è stato certificato: il throttling è attualmente locale al processo. Zotero con un account esterno reale e SMTP di produzione non sono stati esercitati; la loro copertura qui è automatica/simulata e, per l'email, tramite Mailpit.

Architettura, endpoint, strategia d'identità e decisioni per riattivare provider futuri: [audit tecnico](SemanticScholar.md).
