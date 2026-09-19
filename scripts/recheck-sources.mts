import { writeFile } from 'node:fs/promises';

const urls = ['NVDAx','TSLAx','SPYx','QQQx'].map(id => `https://api.xstocks.fi/api/v2/public/assets/${id}/price-data`);
const results = await Promise.all(urls.map(async url => {
  const requestedAt = new Date().toISOString();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
    const body: unknown = await response.json();
    return { url, requestedAt, retrievedAt: new Date().toISOString(), httpStatus: response.status, body,
      validity: 'unverified', reason: 'Price publication time and scaled/unscaled unit basis are not established by this response.' };
  } catch { return { url, requestedAt, retrievedAt: new Date().toISOString(), error: 'Request failed or exceeded 20 seconds; no replacement values.' }; }
}));
await writeFile('docs/evidence/phase2-reference-recheck.json',JSON.stringify(results,null,2)+'\n');
console.log(JSON.stringify(results,null,2));
