import { z } from "zod";
import { ConfigLayer } from "./model";

/** The committed `schema/regional-template.schema.json` (2020-12), drift-checked by CI. */
export function renderJsonSchema(): string {
  return `${JSON.stringify(z.toJSONSchema(ConfigLayer, { target: "draft-2020-12" }), null, 2)}\n`;
}
