import "./sims.css";
import { SIMS } from "./sims-list";

export { SIMS };
export const simById = (id: string) => SIMS.find((s) => s.id === id);
export { SimEmbed } from "./embed";
export type { SimDef } from "./types";
