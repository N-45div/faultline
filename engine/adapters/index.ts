import type { SourceAdapter } from "../types";
import { nycHpd } from "./nycHpd";
import { nyWarn } from "./nyWarn";
import { caWarn } from "./caWarn";
import { mdWarn } from "./mdWarn";
import { coWarn } from "./coWarn";
import { ncWarn } from "./ncWarn";
import { vaWarn } from "./vaWarn";

// One more state is one more file in this folder and one more line here.
export const adapters: Record<string, SourceAdapter<any>> = {
  [nycHpd.id]: nycHpd,
  [nyWarn.id]: nyWarn,
  [caWarn.id]: caWarn,
  [mdWarn.id]: mdWarn,
  [coWarn.id]: coWarn,
  [ncWarn.id]: ncWarn,
  [vaWarn.id]: vaWarn,
};
