/** Pagine HTML essenziali, senza risorse esterne. Tutto ciò che arriva da fuori passa da `esc`. */

export const esc = (value: unknown): string =>
  String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f5f2;--card:#fff;--text:#1d1b19;--muted:#6b665f;--line:#e2ded6;--accent:#5b3df5;--accent-text:#fff;--danger:#b3261e;--ok:#1e7d3c}
@media(prefers-color-scheme:dark){:root{--bg:#161514;--card:#201f1d;--text:#f1eee9;--muted:#a39d94;--line:#35322e;--accent:#8f7bff;--accent-text:#12101f;--danger:#ff8a80;--ok:#7bd89a}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{width:100%;max-width:460px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px}
h1{margin:0 0 12px;font-size:1.3rem;line-height:1.25}
p{margin:0 0 14px}
.muted{color:var(--muted);font-size:.9rem}
.alert{border:1px solid var(--danger);color:var(--danger);border-radius:10px;padding:10px 12px;margin:0 0 14px;font-size:.95rem}
.ok{border:1px solid var(--ok);color:var(--ok);border-radius:10px;padding:10px 12px;margin:14px 0 0}
label{display:block;font-weight:600;margin:0 0 6px}
input[type=password],input[type=text]{width:100%;padding:12px;border:1px solid var(--line);border-radius:10px;background:transparent;color:inherit;font:inherit}
input:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.actions{display:flex;gap:10px;margin-top:18px}
button,.button{flex:1;padding:12px 14px;border-radius:10px;border:1px solid var(--line);background:transparent;color:inherit;font:inherit;font-weight:600;cursor:pointer;text-align:center}
button.primary,.button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-text)}
code{font:.9em ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}
ol{margin:0 0 14px;padding-left:20px}
progress{width:100%;height:10px;margin-top:14px}
[hidden]{display:none}
`;

export interface PageOptions {
  title: string;
  body: string;
  /** Script in linea, eseguito solo grazie al nonce della Content-Security-Policy. */
  script?: string;
  status?: number;
  headers?: Headers;
}

export function page({ title, body, script, status = 200, headers = new Headers() }: PageOptions): Response {
  const nonce = script ? crypto.randomUUID().replace(/-/g, '') : undefined;
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    ...(nonce ? [`script-src 'nonce-${nonce}'`, "connect-src 'self'"] : []),
  ].join('; ');

  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Content-Security-Policy', csp);
  headers.set('X-Frame-Options', 'DENY');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Cache-Control', 'no-store');

  const html = `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
${script && nonce ? `<script nonce="${nonce}">${script}</script>` : ''}
</body>
</html>`;
  return new Response(html, { status, headers });
}

export function messagePage(title: string, message: string, status: number): Response {
  return page({ title, status, body: `<h1>${esc(title)}</h1><p>${esc(message)}</p>` });
}
