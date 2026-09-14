// Read-only smoke test for the ACTUAL hosting layer, not a repository config.
// Usage: node scripts/verify-security-headers.mjs https://your-staging-domain/
import { pathToFileURL } from 'node:url';
export function missingSecurityHeaders(headers) {
  const csp = headers.get('content-security-policy') || '';
  const hsts = headers.get('strict-transport-security') || '';
  return [
    ...(!/(?:^|;)\s*frame-ancestors\s+'none'\s*(?:;|$)/i.test(csp) ? ['CSP frame-ancestors none'] : []),
    ...(!/(?:^|;)\s*object-src\s+'none'\s*(?:;|$)/i.test(csp) ? ['CSP object-src none'] : []),
    ...(!/(?:^|;)\s*base-uri\s+'(?:self|none)'\s*(?:;|$)/i.test(csp) ? ['CSP base-uri'] : []),
    ...(headers.get('x-content-type-options')?.toLowerCase() !== 'nosniff' ? ['X-Content-Type-Options nosniff'] : []),
    ...(!/max-age\s*=\s*[1-9]\d*/i.test(hsts) ? ['HSTS max-age'] : []),
  ];
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = new URL(process.argv[2] || '');
  if (target.protocol !== 'https:' || target.username || target.password) throw Error('Specify an HTTPS URL without credentials.');
  const response = await fetch(target, { signal: AbortSignal.timeout(15000), redirect: 'error' });
  const missing = missingSecurityHeaders(response.headers);
  console.log(JSON.stringify({ url: target.href, status: response.status, missing }, null, 2));
  if (!response.ok || missing.length) process.exitCode = 1;
}
