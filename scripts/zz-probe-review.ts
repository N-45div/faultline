import { slug, foldString } from "../engine/canon";
import { companyTokens, searchTerms, scoreCompany } from "../engine/match";

const names = ["Martin's", "MARTIN'S", "McDonald's Corporation", "Lowe's Home Centers, LLC", "Martin's Food Markets", "Spirit Airlines LLC"];
for (const n of names) {
  const s = slug(n);
  const round = s.replace(/-/g, " ");
  console.log(JSON.stringify({
    name: n,
    slug: s,
    round,
    labelTokens: companyTokens(n),
    queryTokens: companyTokens(round),
    searchTerms: searchTerms(round),
    score: Number(scoreCompany(round, n).toFixed(3)),
  }));
}
