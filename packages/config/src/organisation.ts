import { z } from "zod";
import organisationJson from "../organisation.json" with { type: "json" };

export const Organisation = z.strictObject({
  controllerName: z.string().min(1),
  controllerAddress: z.string().min(1),
  controllerEmail: z.email(),
  dpoName: z.string().min(1),
  dpoAddress: z.string().min(1),
  dpoEmail: z.email(),
});
export type Organisation = z.infer<typeof Organisation>;

/** Build-time organisation details for static clients; deployments replace organisation.json. */
export const organisation = Organisation.parse(organisationJson);
