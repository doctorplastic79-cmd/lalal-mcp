/**
 * Connettore MCP per LALAL.AI su Cloudflare Workers.
 *
 *   /mcp            strumenti MCP, protetti da OAuth
 *   /authorize      pagina in cui l'utente inserisce la propria activation key
 *   /oauth/*        token e registrazione dei client (gestiti dalla libreria)
 *   /u/<ticket>     link temporanei per caricare un file
 */
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { mcpHandler } from './mcp';
import type { Env } from './types';
import { defaultHandler } from './web';

const DAY = 24 * 60 * 60;

/**
 * Il provider vuole conoscere il proprio indirizzo pubblico, che dipende da dove il Worker
 * viene pubblicato (workers.dev o dominio personale). Lo si ricava dalla richiesta: su
 * Cloudflare arrivano solo richieste per gli host instradati verso questo Worker.
 */
const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(origin: string): OAuthProvider<Env> {
  let provider = providers.get(origin);
  if (!provider) {
    provider = new OAuthProvider<Env>({
      apiRoute: '/mcp',
      apiHandler: mcpHandler,
      defaultHandler,
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/oauth/token',
      clientRegistrationEndpoint: '/oauth/register',
      // Claude può presentarsi con la propria identità pubblicata (CIMD) oppure registrarsi (DCR).
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: ['lalal', 'offline_access'],
      requiredScopes: ['lalal'],
      resourceMetadata: {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        resource_name: 'LALAL.AI',
      },
      // Il collegamento dura finché viene usato: scade dopo 180 giorni di inattività.
      refreshTokenTTL: 180 * DAY,
      refreshTokenIdleTTL: 180 * DAY,
    });
    if (providers.size >= 8) providers.clear();
    providers.set(origin, provider);
  }
  return provider;
}

const RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // I metadati della risorsa stanno su `…/oauth-protected-resource/mcp`, dove li indica la
    // risposta 401. Alcuni client li cercano anche senza il percorso: stessa risposta.
    if (url.pathname === RESOURCE_METADATA_PATH && request.method === 'GET') {
      url.pathname = `${RESOURCE_METADATA_PATH}/mcp`;
      request = new Request(url, request);
    }
    return providerFor(url.origin).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
