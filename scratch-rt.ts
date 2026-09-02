import { slug } from "./engine/canon";
import { scoreCompany, companyTokens } from "./engine/match";

const names = [
  "Bush Industries Inc. d/b/a eSolutions Group",
  "Spirit Airlines, LLC",
  "USIC Locating Services, LLC d/b/a Reconn Utility Services",
  "Martin's",
  "McDonald's Corporation",
  "AT&T Services, Inc.",
];
for (const n of names) {
  const s = slug(n);
  const q = s.replace(/-/g, " ");
  console.log(JSON.stringify(n), "->", s);
  console.log("   labelTokens", JSON.stringify(companyTokens(n)));
  console.log("   qTokens    ", JSON.stringify(companyTokens(q)));
  console.log("   score      ", scoreCompany(q, n));
}
