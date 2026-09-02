import { noMatchReceipt, receiptText } from "../engine/receipt";
const at = Date.UTC(2026, 8, 3, 12, 0);
const p = (publisher: string, rows: number) => ({ publisher, url: "u", at, status: 200, rows, lastChecked: at });
const r = noMatchReceipt("Food Lion", [], {
  at,
  followKey: "q:food-lion",
  provenance: [p("New York", 193), p("California", 185), p("Virginia", 1123), p("Maryland", 120), p("Colorado", 90), p("North Carolina", 140), p("New Jersey", 200)],
});
console.log(receiptText(r));
