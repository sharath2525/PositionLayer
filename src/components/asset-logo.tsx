/* eslint-disable @next/next/no-img-element -- provider URLs are runtime metadata and cannot be enumerated in Next image config */

type BrandLogo = {
  name: string;
  color: string;
  path: string;
};

type IdentityIconProps = {
  id: string;
  label?: string;
  logoUrl?: string | null;
  kind?: 'asset' | 'company' | 'fund';
};

// Brand vectors are pinned from Simple Icons 16.15.0 so portfolio rows do not
// depend on a third-party image host at runtime. The surrounding asset name is
// the accessible label, so these repeated marks are decorative.
const BRAND_LOGOS: Record<string, BrandLogo> = {
  NVDAX: {
    name: 'NVIDIA',
    color: '#76b900',
    path: 'M8.948 8.798v-1.43a6.7 6.7 0 0 1 .424-.018c3.922-.124 6.493 3.374 6.493 3.374s-2.774 3.851-5.75 3.851c-.398 0-.787-.062-1.158-.185v-4.346c1.528.185 1.837.857 2.747 2.385l2.04-1.714s-1.492-1.952-4-1.952a6.016 6.016 0 0 0-.796.035m0-4.735v2.138l.424-.027c5.45-.185 9.01 4.47 9.01 4.47s-4.08 4.964-8.33 4.964c-.37 0-.733-.035-1.095-.097v1.325c.3.035.61.062.91.062 3.957 0 6.82-2.023 9.593-4.408.459.371 2.34 1.263 2.73 1.652-2.633 2.208-8.772 3.984-12.253 3.984-.335 0-.653-.018-.971-.053v1.864H24V4.063zm0 10.326v1.131c-3.657-.654-4.673-4.46-4.673-4.46s1.758-1.944 4.673-2.262v1.237H8.94c-1.528-.186-2.73 1.245-2.73 1.245s.68 2.412 2.739 3.11M2.456 10.9s2.164-3.197 6.5-3.533V6.201C4.153 6.59 0 10.653 0 10.653s2.35 6.802 8.948 7.42v-1.237c-4.84-.6-6.492-5.936-6.492-5.936z',
  },
  TSLAX: {
    name: 'Tesla',
    color: '#e82127',
    path: 'M12 5.362l2.475-3.026s4.245.09 8.471 2.054c-1.082 1.636-3.231 2.438-3.231 2.438-.146-1.439-1.154-1.79-4.354-1.79L12 24 8.619 5.034c-3.18 0-4.188.354-4.335 1.792 0 0-2.146-.795-3.229-2.43C5.28 2.431 9.525 2.34 9.525 2.34L12 5.362l-.004.002H12v-.002zm0-3.899c3.415-.03 7.326.528 11.328 2.28.535-.968.672-1.395.672-1.395C19.625.612 15.528.015 12 0 8.472.015 4.375.61 0 2.349c0 0 .195.525.672 1.396C4.674 1.989 8.585 1.435 12 1.46v.003z',
  },
  GOOGLX: {
    name: 'Google',
    color: '#4285f4',
    path: 'M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z',
  },
  NKEX: {
    name: 'Nike',
    color: '#111111',
    path: 'M24 7.8 6.442 15.276c-1.456.616-2.679.925-3.668.925-1.12 0-1.933-.392-2.437-1.177-.317-.504-.41-1.143-.28-1.918.13-.775.476-1.6 1.036-2.478.467-.71 1.232-1.643 2.297-2.8a6.122 6.122 0 0 0-.784 1.848c-.28 1.195-.028 2.072.756 2.632.373.261.886.392 1.54.392.522 0 1.11-.084 1.764-.252L24 7.8z',
  },
  SPCX: {
    name: 'SpaceX',
    color: '#005288',
    path: 'M24 7.417C8.882 8.287 1.89 14.75.321 16.28L0 16.583h2.797C10.356 9.005 21.222 7.663 24 7.417zm-17.046 6.35c-.472.321-.945.68-1.398 1.02l2.457 1.796h2.778zM2.948 10.8H.189l3.25 2.381c.473-.321 1.02-.661 1.512-.945Z',
  },
};

function keyFor(id: string) {
  return id.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

const LOGO_ALIASES: Record<string, string> = {
  NVDA: 'NVDAX', NVIDIA: 'NVDAX',
  TSLA: 'TSLAX', TESLA: 'TSLAX',
  GOOGL: 'GOOGLX', GOOG: 'GOOGLX', ALPHABET: 'GOOGLX',
  NKE: 'NKEX', NIKE: 'NKEX',
  SPCX: 'SPCX', SPACEX: 'SPCX',
};

const ISSUER_SYMBOL_ALIASES: Record<string, string> = {
  NVDA: 'NVDAx', NVIDIA: 'NVDAx',
  TSLA: 'TSLAx', TESLA: 'TSLAx',
  GOOGL: 'GOOGLx', GOOG: 'GOOGLx', ALPHABET: 'GOOGLx',
  NKE: 'NKEx', NIKE: 'NKEx',
  SPCX: 'SPCX', SPACEX: 'SPCX',
};

// Exact icon URLs returned by Jupiter Tokens V2 for the canonical Solana mints.
// They cover loan headers and sample Earn rows, which do not carry token metadata.
const CORE_ASSET_LOGOS: Record<string, string> = {
  SOL: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png',
  USDC: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png',
  JUPUSD: 'https://static.jup.ag/jupUSD/icon.png',
};

function logoFor(id: string) {
  const key = keyFor(id);
  return BRAND_LOGOS[LOGO_ALIASES[key] || key];
}

function safeHttpsUrl(value?: string | null) {
  if (!value) return null;
  try { const url = new URL(value); return url.protocol === 'https:' ? url.toString() : null; }
  catch { return null; }
}

// xStocks publishes the exact logo URL on every verified asset record. The
// token files use the issuer symbol, including its trailing x.
export function issuerLogoUrl(id: string) {
  const raw = id.trim();
  const alias = ISSUER_SYMBOL_ALIASES[keyFor(raw)];
  const symbol = alias || (/^[A-Za-z][A-Za-z0-9.-]{0,11}x$/i.test(raw) ? raw : /^[A-Za-z][A-Za-z0-9.-]{0,10}$/.test(raw) ? `${raw}x` : '');
  if (!symbol) return null;
  return `https://xstocks-metadata.backed.fi/logos/tokens/${encodeURIComponent(symbol)}.png`;
}

export function brandLogoName(id: string) {
  return logoFor(id)?.name ?? null;
}

export function AssetLogo({ id }: { id: string }) {
  const logo = logoFor(id);
  if (!logo) return null;
  return <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" data-asset-logo={logo.name}>
    <path fill={logo.color} d={logo.path}/>
  </svg>;
}


export function IdentityIcon({ id, label, logoUrl, kind = 'asset' }: IdentityIconProps) {
  const brandName = brandLogoName(id);
  const remote = safeHttpsUrl(logoUrl) || CORE_ASSET_LOGOS[keyFor(id)] || (kind === 'company' || kind === 'fund' || /x$/i.test(id) ? issuerLogoUrl(id) : null);
  const fallback = id === 'SPYx' || id === 'SPY' ? 'SPY' : id === 'QQQx' || id === 'QQQ' ? 'QQQ' : id === 'SOL' ? '◎' : id === 'USDC' ? '$' : id.slice(0, 3).toUpperCase();
  const key = keyFor(id).toLowerCase();
  return <span className={`asset-icon identity-icon ${key} ${brandName ? 'brand-logo' : ''} ${kind}-logo`} title={`${label || brandName || id} logo`} aria-hidden="true">
    {brandName ? <AssetLogo id={id}/> : <span className="identity-fallback" aria-hidden="true">{fallback}</span>}
    {remote && <img className="identity-remote" src={remote} alt="" aria-hidden="true" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={event => { event.currentTarget.hidden = true; }}/>}</span>;
}
