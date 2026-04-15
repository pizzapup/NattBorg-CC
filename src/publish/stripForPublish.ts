import type { RpgSystem } from "../types";

/** Remove designer-only notes before exposing payload to players. */
export function stripForPublish(s: RpgSystem): RpgSystem {
  const o = structuredClone(s);
  if (o.systemDocs?.designerNotes != null && o.systemDocs.designerNotes !== "") {
    const { designerNotes: _d, ...rest } = o.systemDocs;
    o.systemDocs = Object.keys(rest).length > 0 ? rest : undefined;
  }
  return o;
}
