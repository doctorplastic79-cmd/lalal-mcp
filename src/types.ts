import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

export interface Env {
  /** Token OAuth, client registrati e link di caricamento. Nulla di sensibile è in chiaro. */
  OAUTH_KV: KVNamespace;
  /** Helper iniettati da OAuthProvider nelle richieste gestite dal defaultHandler. */
  OAUTH_PROVIDER: OAuthHelpers;
  /**
   * Facoltativa: redirect OAuth aggiuntivi da accettare oltre a quelli di Claude, separati da
   * virgola. Si imposta tra le variabili del Worker nel pannello Cloudflare.
   */
  EXTRA_REDIRECT_URIS?: string;
  /** Solo per i test: indirizzo alternativo dell'API LALAL.AI. */
  LALAL_API_BASE?: string;
}

/** Ciò che il collegamento OAuth porta con sé: arriva decifrato in `ctx.props` a ogni chiamata MCP. */
export interface Props {
  licenseKey: string;
}
