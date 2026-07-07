// Only treat a link as a clickable anchor target when it parses to an https URL. Anything else
// (null, relative, javascript:, data:, http:) returns null so callers render plain text instead of
// an anchor. This blocks javascript:/data: URL injection from untrusted collected metadata
// (document.web_view_link, citation links) that originates outside our control.
export function safeHttpsLink(link: string | null | undefined): string | null {
  if (!link) return null
  try {
    const url = new URL(link)
    return url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}
