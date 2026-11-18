# Connettore LALAL.AI per Claude

Server MCP remoto che dà a Claude gli strumenti di [LALAL.AI](https://www.lalal.ai/): separazione
degli stem (voce, base, batteria, basso…), pulizia della voce, rimozione della musica di fondo e
cambio voce. Gira su Cloudflare Workers, piano gratuito, e si aggiunge a Claude come
*connettore personalizzato*.

## Strumenti

| Strumento | Cosa fa |
| --- | --- |
| `lalal_separate_stem` | Estrae uno stem da una canzone (con `vocals`: base karaoke + voce). Opzione voce solista/cori. |
| `lalal_separate_multistem` | Estrae più stem in un solo passaggio. |
| `lalal_clean_voice` | Toglie il rumore di fondo da un parlato. |
| `lalal_remove_music` | Separa la voce dalla musica di sottofondo (video, podcast). |
| `lalal_change_voice` | Sostituisce la voce con quella di un voice pack. |
| `lalal_list_voice_packs` | Elenca le voci clonate dell'account. |
| `lalal_upload_from_url` | Carica un file da un link diretto (anche Google Drive e Dropbox pubblici). |
| `lalal_create_upload_link` / `lalal_upload_status` | Link temporaneo per caricare un file dal telefono o dalla chat. |
| `lalal_check_tasks` / `lalal_cancel_tasks` | Stato e annullamento delle elaborazioni. |
| `lalal_minutes_left` | Minuti residui. |
| `lalal_delete_source` | Elimina file e risultati dai server LALAL.AI. |

## Come funziona l'accesso

Quando in Claude premi **Connetti**, si apre una pagina di questo server che chiede la tua
*activation key* di LALAL.AI (profilo su lalal.ai, oppure email di acquisto). La chiave viene
verificata con LALAL.AI e legata al collegamento OAuth di Claude:

- non passa mai dalla chat e Claude non la vede;
- nello spazio KV resta solo cifrata, con una chiave che possiede soltanto chi ha il token;
- il server accetta collegamenti solo da Claude (`claude.ai`, `claude.com`) e da programmi sul tuo computer, come Claude Code.

L'API di LALAL.AI richiede il piano Pro o un pacchetto di minuti. Ogni elaborazione consuma
minuti: durata del file × numero di stem.

## Pubblicazione su Cloudflare

Serve un account Cloudflare (gratuito). Il modo più semplice è il pulsante:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/doctorplastic79-cmd/claude-skills/tree/lalal-mcp/connectors/lalal-mcp)

Cloudflare copia questo progetto in un repository tuo, crea lo spazio KV e pubblica il Worker
all'indirizzo `https://lalal-mcp.<sottodominio>.workers.dev`. Non ci sono segreti né variabili
da compilare: lascia i valori proposti e conferma.

In alternativa, da terminale, in una cartella con questo progetto:

```bash
npm ci
npx wrangler deploy
```

## Collegamento a Claude

1. Apri l'indirizzo del Worker: la pagina mostra l'URL del connettore, che finisce con `/mcp`.
2. In Claude (web, desktop o app): **Connettori** → **Aggiungi connettore personalizzato** →
   nome `LALAL.AI`, incolla l'URL e conferma.
3. Premi **Connetti** e inserisci la activation key.

Per scollegarlo basta **Disconnetti** in Claude. Per azzerare tutti gli accessi in un colpo,
svuota lo spazio KV `OAUTH_KV` dal pannello Cloudflare.

## Limiti

- File caricati dal link temporaneo: massimo 100 MB (limite di Cloudflare); il link vale un'ora.
  Per file più grandi usa un link diretto al file.
- Una chiamata attende il risultato fino a 3 minuti; oltre, restituisce un `task_id` da
  controllare con `lalal_check_tasks`.
- I link ai risultati sono di LALAL.AI e scadono insieme al file caricato: conviene scaricarli subito.
- Un collegamento non usato per 180 giorni scade e va rifatto.

## Sviluppo

```bash
npm run typecheck   # controllo dei tipi
npm test            # test end-to-end: Worker locale + finto LALAL.AI, stesso percorso OAuth di Claude
npm run dev         # Worker in locale su http://localhost:8787
```

Struttura: `src/index.ts` (provider OAuth), `src/authorize.ts` (pagina di collegamento),
`src/mcp.ts` (protocollo MCP), `src/tools.ts` (strumenti), `src/lalal.ts` (client dell'API),
`src/sources.ts` (file da URL), `src/uploads.ts` (link di caricamento).

Riferimenti: [API LALAL.AI v1](https://www.lalal.ai/api/v1/docs/) ·
[requisiti dei connettori Claude](https://claude.com/docs/connectors/building/authentication) ·
[workers-oauth-provider](https://github.com/cloudflare/workers-oauth-provider)
