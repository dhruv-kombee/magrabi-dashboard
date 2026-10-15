/** Renders in the viewer's own local timezone, not raw UTC -- same behavior as the original
 * vanilla-JS portal's fmtTime(). */
export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString()
}
