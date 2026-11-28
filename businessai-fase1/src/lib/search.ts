/**
 * Text for a PostgREST ilike search inside `.or(...)` (review finding M9):
 * characters with a meaning in the filter grammar (, ( ) : " ' \ * % _ .) are
 * removed, spaces collapsed, length capped. What remains is matched as
 * plain text; it can never add another filter condition.
 */
export function searchTerm(value: string | null | undefined, max = 60): string {
  return String(value ?? '').replace(/[%_,()*\\:"'.]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}
