#!/usr/bin/env bash
# Draft gate for apply-migrations.sh (review finding I12).
# draft_gate <migrations dir> <approved csv> <known csv> <pending name>...
#   Prints "RUN <name>" for each pending migration that may be applied and
#   "HOLD <name>" from the first one that must wait, onwards (later
#   migrations may depend on it, so they wait too).
#   A pending migration waits when its file has the line
#   "-- STAGING-GATE: approval required" and it is neither
#     * in <approved csv> (APPROVED_DRAFTS, given for this run), nor
#     * in <known csv>: exactly this content was already applied here (the
#       recorded sha256 equals the file's). Re-applying it — e.g. after an
#       earlier record was lost — needs no new approval and keeps the
#       database consistent with the records.
#   A missing file always waits (never applied blindly).
draft_gate() {
  local dir="$1" approved=",${2:-}," known=",${3:-},"; shift 3
  local holding=0 name
  for name in "$@"; do
    if [[ "$holding" == 0 ]]; then
      if [[ ! -f "$dir/$name.sql" ]]; then
        holding=1
      elif grep -q '^-- STAGING-GATE: approval required' "$dir/$name.sql" \
           && [[ "$approved" != *",$name,"* && "$known" != *",$name,"* ]]; then
        holding=1
      fi
    fi
    if [[ "$holding" == 1 ]]; then echo "HOLD $name"; else echo "RUN $name"; fi
  done
}
