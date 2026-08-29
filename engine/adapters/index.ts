import type { SourceAdapter } from "../types";
import { nycHpd } from "./nycHpd";
import { nyWarn } from "./nyWarn";
import { caWarn } from "./caWarn";

// A fourth source is one more file in this folder and one more line here.
export const adapters: Record<string, SourceAdapter<any>> = {
  [nycHpd.id]: nycHpd,
  [nyWarn.id]: nyWarn,
  [caWarn.id]: caWarn,
};
