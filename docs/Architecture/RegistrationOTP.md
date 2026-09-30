# Registrazione OTP ed email account

La registrazione segue **email → OTP → nome/password e accettazioni → sessione**. OTP solo per la registrazione iniziale; login, recupero password e cambio email mantengono i rispettivi contratti. Google, federazione e passkey non sono inclusi.

## Contratti API

Prefisso `/api/v1/auth/registration`. Richieste JSON; cookie inviati con `credentials: include`. Tutte le risposte auth sono `Cache-Control: no-store`. OpenAPI espone gli schemi aggiornati.

| Metodo e percorso | Input | Risultato |
| --- | --- | --- |
| POST `/start` | `email`, `locale` (`it`/`en`, default `en`) | 202, cookie e stato OTP; email accodata se l'account non è verificato |
| GET `/status` | Cookie eventuale | 200, fase `email`, `otp`, `profile`, `expired` o `locked` |
| POST `/resend` | Cookie | 202, nuova generazione; 429 durante cooldown/limiti |
| POST `/verify` | `code` stringa di sei cifre, cookie | 200, fase `profile`, cookie ruotato; nessun accesso autenticato |
| POST `/complete` | `display_name`, `password`, `accept_terms: true`, `terms_version`, `privacy_version`, cookie ruotato | 200, normale `TokenResponse` e cookie refresh; registrazione consumata |

Lo stato contiene solo fase, email mascherata, `expires_at`, `otp_expires_at` e `resend_after` in secondi. Le date sono ISO UTC. La password richiede 8–128 caratteri. Il passaggio finale richiede anche conferma password: il frontend verifica la corrispondenza e trasmette solo la password, senza conservare la conferma. Il limite minimo è condiviso da registrazione, recupero e cambio password; nome 1–100 caratteri dopo trim. Un cambio delle versioni legali restituisce 409 `registration_legal_changed`, preservando la verifica: ricaricare i documenti e richiedere nuovamente l'accettazione.

Errori OTP: 400 `registration_code_invalid`, `registration_code_expired`, `registration_locked`, `registration_expired`; limiti 429 con `Retry-After`; Redis indisponibile 503. Il client conserva il form, aggiorna lo stato e offre reinvio/ripartenza. La correzione email avvia una nuova challenge; su un altro browser occorre ripartire. Nessun token viene inserito in URL o Web Storage.

I precedenti POST `/auth/register`, `/auth/verify-email`, `/auth/email/resend` restituiscono 410 e sono deprecati in OpenAPI. `/check-email` e `/verify-email` indirizzano al nuovo percorso, eliminando l'eventuale frammento URL.

## Stato, sicurezza e concorrenza

`RegistrationChallenge` è separata da `User`. Cookie casuale a 256 bit, solo digest SHA-256 nel database; `__Host-openbib_registration` in produzione, `openbib_registration` in HTTP locale, HttpOnly, SameSite=Strict, Path=/, Secure in produzione. I POST richiedono l'Origin applicativo in produzione, come le sessioni esistenti.

OTP crittografico a sei cifre inclusi zeri iniziali, HMAC-SHA256 su ID challenge, generazione e codice, chiave HKDF con purpose `registration-otp` dal keyring versionato esistente. Nessuna nuova credenziale. Conservare le vecchie versioni del keyring fino alla scadenza delle challenge/coda; rimuoverle anticipatamente richiede un nuovo codice. Il codice leggibile viene persistito soltanto nel payload email cifrato.

- OTP: 10 minuti, ridotti alla durata residua della challenge.
- Challenge iniziale: 30 minuti; dopo verifica: 15 minuti per completare.
- Cinque errori cumulativi, non azzerati dal reinvio. Gli errori restituiscono una risposta normale anziché sollevare un'eccezione che annullerebbe la transazione.
- Reinvio dopo 60 secondi; nuova generazione, con prevenzione della coincidenza numerica col codice precedente quando la vecchia chiave è disponibile.
- Start e resend condividono bucket Redis per email normalizzata e IP: capacità 5, ricarica 5/ora. Anche richieste anticipate al reinvio consumano capacità.
- Verify: capacità 10, ricarica 10/10 minuti per IP. Complete ha un ulteriore bucket equivalente. Tutti falliscono chiusi senza Redis.

Le scritture acquisiscono prima il lock advisory PostgreSQL sull'email normalizzata, poi il lock sulla challenge. La query rilegge il digest dopo l'attesa per rilevare cookie ruotati. Il vincolo univoco su `User.email` resta l'ultima difesa. Verifica e completamento sono monouso; il completamento invalida tutte le challenge residue della stessa email. Avviarle non le invalida reciprocamente.

Account verificati: risposta iniziale identica, nessuna email o sostituzione credenziali. Account legacy non verificati: dopo OTP il proprietario può impostare le credenziali, mantenendo l'ID e revocando azioni/sessioni precedenti. Il worker elimina challenge scadute o consumate dopo 23 ore, con esecuzione oraria: entro 24 ore durante il normale funzionamento. Monitorare worker e heartbeat; un fermo prolunga la retention fino alla ripartenza.

## Email

`auth/email.py` produce oggetto, testo e HTML in IT/EN. Layout comune a tabelle, CSS inline, font di sistema, colonna fluida max 600 px, colori OpenBib; codice, pulsante e collegamento alternativo restano testo. Impostazione basata sulle [indicazioni Mailchimp](https://templates.mailchimp.com/getting-started/html-email-basics/); non costituisce certificazione di compatibilità dei client.

`auth/assets/logo.png` deriva da `frontend/public/favicon.svg` (Folio), rasterizzato a 108×108 px e visualizzato a 36×36. È incluso nel pacchetto Python e allegato inline con Content-ID `openbib-logo`; nessuna immagine remota. Aggiornare il PNG insieme al logo originale in caso di rebranding.

Il worker invia `multipart/alternative` con testo e HTML; l'HTML contiene una parte `multipart/related` per il PNG. I vecchi payload solo testo restano validi. HTML, destinatario e metadati della challenge sono nella coda cifrata esistente. Prima dell'invio il worker scarta challenge inesistenti, consumate, verificate, bloccate, scadute o di generazione superata. Una mail già in trasmissione può arrivare, ma il vecchio codice resta invalido. Rimangono retry SMTP limitati, cancellazione del payload dopo invio/fallimento terminale e log privi di codici/password/cookie.

`APP_PUBLIC_URL` costruisce link e footer privacy/termini; keyring e SMTP mantengono le configurazioni esistenti. Non è necessario modificare `.env`. Allineare versione privacy e configurazione legale dell'istanza prima di pubblicare la nuova informativa.

## Migrazione e collaudo locale

Migrazione `e7f8a9b0c1d2`, successiva a `d6e7f8a9b0c1`: crea la tabella e consuma solo i vecchi token `verify_email`. Recupero password, cambio email e account rimangono intatti. Il downgrade rimuove la tabella ma non riabilita link già invalidati. Coordinare aggiornamento API/worker e migrazione: non lasciare attiva una vecchia API che emetta link di registrazione.

Docker: fermare API/worker, ricostruire lo stack con `docker compose up -d --build`; il servizio migrate applica lo schema. Non usare `down -v`. Rispettare eventuali override del database locale.

Aprire http://localhost:3000/register e http://localhost:8025. Inserire un indirizzo di prova, leggere il codice in Mailpit, verificarlo nel browser iniziale, scegliere nome/password e accettare i documenti. Ricaricare durante OTP e durante il profilo per verificare il recupero della fase. Provare recupero password e cambio email da Impostazioni. Mailpit intercetta SMTP solo nello stack locale.

Test automatici: `test_registration.py` (contratti, tentativi, limiti, scadenze, account legacy, cookie, template, worker), `test_auth_concurrency.py` (PostgreSQL reale), test auth/email preesistenti, `scripts.check_migrations` (database usa e getta), `RegisterPage.test.tsx` e `AccountLifecyclePages.test.tsx`. I test PostgreSQL richiedono `TEST_DB_URL` con database che termina in `_test`; Redis test deve essere isolato perché viene svuotato. Non puntare le suite al database applicativo.
