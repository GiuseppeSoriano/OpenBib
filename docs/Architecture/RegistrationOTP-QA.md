# Collaudo registrazione OTP – 27 settembre 2026

Branch `codex/semantic-scholar-provider`; modifiche locali, senza commit/push/PR/merge. Inclusa la modifica successiva richiesta: password di almeno **8 caratteri** e conferma corrispondente nel passaggio finale. Il limite 8–128 è coerente anche in recupero e cambio password.

## Risultati

| Controllo | Esito |
| --- | --- |
| Backend `.venv/bin/pytest -q`, SQLite/fakeredis | 199 passati, 8 saltati (5 PostgreSQL, 3 Semantic Scholar live) |
| Stessa suite con `TEST_DB_URL`/`TEST_REDIS_URL` isolati | 204 passati, 3 Semantic Scholar live saltati |
| `python -m scripts.check_migrations`, PostgreSQL usa e getta | Schema pulito, schema precedente, cifratura, rollback su errore e migrazione pre-OTP superati |
| `ruff check .` e `ruff format --check .` | Superati |
| Frontend `npm test` | 103 passati, 21 file |
| Frontend `npm run lint` | Superato |
| Frontend `npm run build` | TypeScript e Vite superati; avviso già presente sui bundle oltre 500 kB |
| `git diff --check` | Superato |
| Docker rebuild + migrazione | Applicati; Alembic `e7f8a9b0c1d2 (head)` |
| Readiness | API, database e Redis `ok` |
| OpenAPI del container aggiornato | Cinque endpoint e minimo password 8 verificati |

PostgreSQL e Redis per i test erano container dedicati sulle porte 15432/16379. Le suite distruttive non hanno usato il database applicativo. Lo stack applicativo mantiene l'override del database `openbib_semantic_scholar` e i volumi esistenti.

## Percorso reale API/SMTP

Un account sintetico ha completato start → OTP da Mailpit → verify → complete, ottenendo una sessione. Verificati cookie ruotato, nessun accesso dopo il solo OTP, login con password, recupero password e invalidazione della sessione, cambio email e nuova invalidazione, login con nuovo indirizzo, cancellazione dell'account sintetico e rifiuto della sua vecchia sessione. Le tre email sono state effettivamente consegnate dal worker SMTP locale.

La prima esecuzione dello script di collaudo si è fermata prima di creare un account perché il parser della fixture non considerava CRLF SMTP; corretto lo script e ripetuto con successo. Non era un errore dell'applicazione. Le registrazioni temporanee di prova rimaste seguono la normale scadenza/pulizia.

## Browser ed email

Verificati nel browser: form iniziale senza password, passaggio OTP con autofill/tastiera numerica dichiarati, inserimento del codice, recupero della fase dopo refresh, profilo finale, ritorno alla scelta dell'email. Dopo l'ultima ricostruzione sono visibili minimo 8 e conferma password. Completamento/sessione frontend e blocco delle password diverse sono coperti dai test React; il completamento reale e le modifiche credenziali sono stati eseguiti via API di collaudo, senza compilare password nel browser automatizzato.

Tutte e tre le email sono state ispezionate in Mailpit in vista desktop e telefono: logo CID presente, gerarchia leggibile, codice selezionabile, pulsante e URL alternativo. Le misurazioni DOM nelle viste telefono di recupero/cambio email non mostrano overflow orizzontale. Inoltre l'HTML effettivamente ricevuto è stato renderizzato in anteprime locali da 390 px, sostituendo il logo con testo alternativo: codice, istruzioni, link e scadenze restano leggibili. Questa è una simulazione locale delle immagini disabilitate, non un test su client email esterni.

Non sono certificati Gmail, Outlook, Apple Mail o consegna SMTP in produzione. Il controllo automatico HTML di Mailpit non equivale a una certificazione dei client. I test Semantic Scholar live non sono stati rieseguiti perché non pertinenti al flusso account.

## Sicurezza e preservazione dati

Test inclusi: zeri iniziali, errori cumulativi persistiti, blocco al quinto tentativo, resend/cooldown/collisione casuale, vecchio codice rifiutato, scadenze, Redis indisponibile, limiti condivisi per email/IP, cookie/Origin, termini cambiati, account verificati invariati e recupero legacy, concorrenza PostgreSQL, email obsolete, vecchi payload testuali, MIME/PNG e retry SMTP.

`.env` non tracciato. Le credenziali configurate non risultano nei file modificati o nei log di collaudo; OTP e link sintetici non risultano nei log API/worker. Nessun traceback nei log finali. I dati preesistenti e l'account di test già fornito all'utente non sono stati cancellati; solo l'account creato dal collaudo API è stato eliminato.

Per una prova manuale: ricaricare http://localhost:3000/register, usare http://localhost:8025 per leggere l'OTP, completare con password e conferma uguali. I limiti per IP sono condivisi tra registrazioni locali e possono richiedere attesa dopo ripetuti tentativi. Lo stack Docker rimane avviato.
