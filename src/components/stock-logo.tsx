'use client';

import { useState } from 'react';
import Image from 'next/image';
import { AssetLogo, brandLogoName } from './asset-logo';

// Local, unbadged company marks. See public/stock-logos/README.md for provenance.
const localSymbols = new Set(['AAPL', 'MSFT', 'AMZN', 'TSM', 'AVGO', 'META', 'JPM',
  'LLY', 'WMT', 'V', 'ORCL', 'MA', 'XOM', 'COST', 'NFLX', 'MU', 'AMD', 'BRK-B', 'ASML', 'JNJ']);

export function StockLogo({ url, symbol }: { url: string | null; symbol: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  // Only strip the issuer's lowercase x suffix; XOM and other real tickers remain intact.
  const company = symbol.replace(/x$/, '').toUpperCase().replace(/^BRK\.B$/, 'BRK-B');
  const local = localSymbols.has(company) ? `/stock-logos/${company}.png` : null;
  const vector = brandLogoName(company);
  const issuer = url?.startsWith('https://xstocks-metadata.backed.fi/logos/tokens/') ? url : null;
  const source = local ?? issuer;
  const showImage = source !== null && failed !== source;
  return <span className="market-avatar stock-company-logo" aria-hidden="true" data-company={company}
    data-logo-state={vector || (local && showImage) ? 'company-mark' : showImage ? 'issuer-mark' : 'initials-fallback'}>
    {vector ? <AssetLogo id={company}/> : showImage ? <Image src={source} alt="" width={40} height={40}
      unoptimized referrerPolicy="no-referrer" onError={() => setFailed(source)}/> : company.slice(0, 2)}
  </span>;
}
