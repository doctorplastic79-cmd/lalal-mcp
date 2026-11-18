/**
 * Pagina di collegamento (`/authorize`). Al posto di un login, l'utente inserisce la propria
 * activation key di LALAL.AI: viene verificata con LALAL.AI e poi legata, cifrata, al token
 * OAuth che Claude userà. La chiave non passa mai dalla chat.
 */
import { AuthorizationError, CimdFetchError } from '@cloudflare/workers-oauth-provider';
import { esc, messagePage, page } from './html';
import { Lalal, LalalApiError } from './lalal';
import type { Env, Props } from './types';

/** Callback OAuth di Claude (web, desktop, mobile). La seconda è quella annunciata per il futuro. */
const CLAUDE_REDIRECT_URIS = ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'];

interface ConsentView {
  handle: string;
  client: string;
  domain: string;
  redirectHost: string;
  loopback: boolean;
  error?: string;
}

export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  if (request.method === 'GET') return showConsent(request, env);
  if (request.method === 'POST') return submitConsent(request, env);
  return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, POST' } });
}

async function showConsent(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  try {
    const authRequest = await oauth.parseAuthRequest(request);
    // Chiunque può registrare un client: senza questo controllo una pagina malevola potrebbe
    // farsi consegnare l'accesso su un proprio indirizzo dopo averti fatto inserire la chiave.
    if (!isRedirectAllowed(authRequest.redirectUri, env)) {
      return messagePage(
        'Collegamento non consentito',
        'Questo connettore accetta solo richieste di collegamento che arrivano da Claude.',
        403,
      );
    }
    const details = await oauth.describeConsent(authRequest);
    const consent = await oauth.beginConsent(authRequest);
    return consentPage(
      {
        handle: consent.handle,
        client: details.clientName,
        domain: details.clientDomain ?? '',
        redirectHost: details.redirectHost,
        loopback: details.redirectIsLoopback,
      },
      consent.headers,
    );
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) {
      return Response.redirect(error.redirectTo, 302);
    }
    if (error instanceof AuthorizationError) {
      return messagePage('Richiesta di collegamento non valida', error.description, 400);
    }
    if (error instanceof CimdFetchError) {
      return messagePage(
        'Applicazione non verificabile',
        'Non è stato possibile verificare l’applicazione che chiede il collegamento. Riprova da Claude.',
        400,
      );
    }
    throw error;
  }
}

async function submitConsent(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const form = await request.formData();
  const field = (name: string) => {
    const value = form.get(name);
    return typeof value === 'string' ? value : '';
  };
  const handle = field('handle');

  try {
    if (field('decision') !== 'approve') {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }

    // La chiave si verifica prima di consumare la richiesta: se è sbagliata si può riprovare.
    const licenseKey = field('license_key').trim();
    const problem = await checkLicenseKey(licenseKey, env);
    if (problem) {
      // I campi mostrati tornano dal modulo solo per essere ridisegnati: la richiesta vera
      // resta sul server, legata a `handle` e al browser che ha aperto la pagina.
      return consentPage(
        {
          handle,
          client: field('client') || 'Claude',
          domain: field('domain'),
          redirectHost: field('redirect_host'),
          loopback: field('loopback') === '1',
          error: problem,
        },
        undefined,
        422,
      );
    }

    const approved = await oauth.approveConsent(request, handle);
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: await userIdFor(licenseKey),
      metadata: {},
      scope: approved.request.scope,
      props: { licenseKey } satisfies Props,
      // Un nuovo collegamento non spegne quelli già attivi (per esempio da un altro account Claude
      // con la stessa chiave): i vecchi accessi scadono da soli quando non vengono più usati.
      revokeExistingGrants: false,
    });
    approved.headers.set('Location', redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return messagePage(
        'Pagina scaduta',
        'Questa pagina è scaduta o è già stata usata. Torna su Claude e avvia di nuovo il collegamento.',
        400,
      );
    }
    throw error;
  }
}

/** Restituisce il messaggio da mostrare se la chiave non va bene, altrimenti `null`. */
async function checkLicenseKey(licenseKey: string, env: Env): Promise<string | null> {
  if (!licenseKey) return 'Inserisci la tua activation key.';
  // Finisce in un header HTTP: solo caratteri ASCII stampabili, senza spazi.
  if (licenseKey.length > 200 || !/^[\x21-\x7e]+$/.test(licenseKey)) {
    return 'La chiave contiene caratteri non validi: copiala di nuovo dal tuo profilo LALAL.AI.';
  }
  try {
    await new Lalal(licenseKey, env.LALAL_API_BASE).minutesLeft();
    return null;
  } catch (error) {
    if (error instanceof LalalApiError && error.invalidKey) {
      return 'LALAL.AI non riconosce questa chiave: è sbagliata o non più attiva.';
    }
    if (error instanceof LalalApiError && error.status >= 400 && error.status < 500) {
      const detail = typeof error.detail === 'string' ? error.detail : JSON.stringify(error.detail);
      return `LALAL.AI ha rifiutato la chiave: ${detail}`;
    }
    return 'Non riesco a verificare la chiave con LALAL.AI in questo momento. Riprova tra poco.';
  }
}

export function isRedirectAllowed(redirectUri: string, env: Env): boolean {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return false;
  }
  // Claude Code e gli strumenti di sviluppo ricevono l'accesso su una porta locale del computer.
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(\.\d{1,3}){3}$/.test(url.hostname);
  if (url.protocol === 'http:' && loopback) return true;

  const extra = (env.EXTRA_REDIRECT_URIS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return [...CLAUDE_REDIRECT_URIS, ...extra].includes(redirectUri);
}

/** Identificativo stabile ma non reversibile: ricollegarsi con la stessa chiave sostituisce il vecchio accesso. */
async function userIdFor(licenseKey: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`lalal-mcp user v1:${licenseKey}`));
  const hex = [...new Uint8Array(digest).slice(0, 8)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `lalal-${hex}`;
}

function consentPage(view: ConsentView, headers?: Headers, status = 200): Response {
  const origin = view.domain
    ? `Applicazione pubblicata da <strong>${esc(view.domain)}</strong>.`
    : 'Il nome è dichiarato dall’applicazione stessa.';
  const loopbackWarning = view.loopback
    ? `<p class="alert">L’accesso verrà consegnato a un programma su questo computer. Continua solo se hai appena avviato tu il collegamento da lì.</p>`
    : '';
  const error = view.error ? `<p class="alert" role="alert">${esc(view.error)}</p>` : '';

  return page({
    title: 'Collega LALAL.AI',
    status,
    headers,
    body: `<h1>Collega LALAL.AI</h1>
<p><strong>${esc(view.client)}</strong> chiede di usare il tuo account LALAL.AI. ${origin} L’accesso verrà inviato a <strong>${esc(view.redirectHost)}</strong>.</p>
${loopbackWarning}${error}
<form method="post" autocomplete="off">
  <input type="hidden" name="handle" value="${esc(view.handle)}">
  <input type="hidden" name="client" value="${esc(view.client)}">
  <input type="hidden" name="domain" value="${esc(view.domain)}">
  <input type="hidden" name="redirect_host" value="${esc(view.redirectHost)}">
  <input type="hidden" name="loopback" value="${view.loopback ? '1' : '0'}">
  <label for="license_key">Activation key di LALAL.AI</label>
  <input id="license_key" name="license_key" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" autofocus>
  <p class="muted" style="margin-top:10px">La trovi nel tuo profilo su lalal.ai e nell’email di acquisto. L’API richiede il piano Pro o un pacchetto di minuti.</p>
  <p class="muted">La chiave resta cifrata su questo server e serve solo per le operazioni che chiedi a Claude. Ogni elaborazione consuma i minuti del tuo account.</p>
  <div class="actions">
    <button class="primary" name="decision" value="approve">Collega</button>
    <button name="decision" value="deny">Annulla</button>
  </div>
</form>`,
  });
}
