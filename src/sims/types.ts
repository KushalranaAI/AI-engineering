import type { ComponentType } from "react";
import type { SimId } from "../curriculum/practice/types";

/** One interactive simulator. The component is self-contained: controls, a live visual, and a plain-language readout. */
export interface SimDef {
  id: SimId;
  title: string;
  /** one sentence shown on cards */
  blurb: string;
  /** levels whose lessons this belongs to */
  levels: number[];
  /** an everyday picture of what the sim shows, one sentence */
  realLife: string;
  Component: ComponentType;
}
