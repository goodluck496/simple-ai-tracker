/** Keep browser requests under the externally mounted application path. */
export function publicUrl(url: string): string {
  if (!url.startsWith('/api/')) return url;
  const resolved = new URL(url.slice(1), document.baseURI);
  return resolved.pathname + resolved.search + resolved.hash;
}
