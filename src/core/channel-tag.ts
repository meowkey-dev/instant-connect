/**
 * Shared <channel> XML tag formatting for MCP channel notifications.
 */

/** Escape a string for use as an XML attribute value. */
export function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Build a `<channel ...>body</channel>` XML tag.
 *
 * @param attrs - Key/value pairs for the tag attributes (values are escaped automatically).
 * @param body  - Tag body content (not escaped — caller controls this).
 */
export function formatChannelTag(attrs: Record<string, string | number>, body: string): string {
  const attrStr = Object.entries(attrs)
    .map(([k, v]) => `${k}="${escapeAttr(String(v))}"`)
    .join(' ')
  return `<channel ${attrStr}>\n${body}\n</channel>`
}
