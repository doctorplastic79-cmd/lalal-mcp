/** Tutto ciò che non è MCP né OAuth: pagina di collegamento, link di caricamento, pagina iniziale. */
import { handleAuthorize } from './authorize';
import { esc, messagePage, page } from './html';
import type { Env } from './types';
import { handleUploadRoute } from './uploads';

export const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/authorize') return handleAuthorize(request, env);
    if (url.pathname.startsWith('/u/')) return handleUploadRoute(request, env);
    if (url.pathname === '/') return homePage(url.origin);
    if (url.pathname === '/robots.txt') {
      return new Response('User-agent: *\nDisallow: /\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    return messagePage('Pagina non trovata', 'Questo indirizzo non esiste.', 404);
  },
};

function homePage(origin: string): Response {
  const mcpUrl = `${origin}/mcp`;
  return page({
    title: 'Connettore LALAL.AI per Claude',
    body: `<h1>Connettore LALAL.AI per Claude</h1>
<p>Il server è attivo. Questo è l’indirizzo da inserire in Claude:</p>
<p><input type="text" readonly value="${esc(mcpUrl)}" aria-label="Indirizzo del connettore"></p>
<ol>
  <li>In Claude apri i <strong>Connettori</strong> e scegli <strong>Aggiungi connettore personalizzato</strong>.</li>
  <li>Dagli un nome, ad esempio <strong>LALAL.AI</strong>, e incolla l’indirizzo qui sopra, compreso <code>/mcp</code> finale.</li>
  <li>Premi <strong>Connetti</strong> e inserisci la tua activation key di LALAL.AI.</li>
</ol>`,
  });
}
