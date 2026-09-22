import type { FunctionReturnType } from "convex/server";
import { api } from "../convex/_generated/api";
import { violationsPage } from "../engine/hpdOnline";

// HPD Online's own page for a repair, under its row once it is answered: what
// the city's website printed when Firecrawl searched it for the number, quoted
// as it printed it, and the data file's words for the same repair on the line
// below. Neither is said to be the other; they are the city's two places, side
// by side. The picture and the markdown are the copies kept, and the hash is
// of the markdown. A reading that kept nothing says so, and why.

export type CityPageRead = FunctionReturnType<typeof api.cityPage.forViolations>[number];

/** A reading still marked as going after this long did not finish (convex/cityPage.ts holds another off as long). */
const STALE_MS = 10 * 60_000;

/** A time as the thread prints its own, with the day when it is not today. */
function when(ms: number): string {
  const iso = new Date(ms).toISOString();
  const time = `${iso.slice(11, 16)} UTC`;
  return iso.slice(0, 10) === new Date().toISOString().slice(0, 10) ? time : `${iso.slice(0, 10)} ${time}`;
}

export default function CityPage({ read, violationId, cityStatus, cityDate }: { read: CityPageRead | undefined; violationId: string; cityStatus: string; cityDate: string }) {
  if (!read) return null;
  const site = read.buildingId ? (
    <a href={violationsPage(read.buildingId)} target="_blank" rel="noreferrer">
      HPD Online
    </a>
  ) : (
    "HPD Online"
  );
  const dataFile = (
    <p>
      The city's data file: {cityStatus}, {cityDate}
    </p>
  );
  const kept = read.sha256 ? (
    <div className="try-city-page-kept">
      {read.screenshotUrl && (
        <a href={read.screenshotUrl} target="_blank" rel="noreferrer">
          <img src={read.screenshotUrl} loading="lazy" alt={`HPD Online's violations page, searched for #${violationId}, as Firecrawl saw it`} />
        </a>
      )}
      <p className="try-city-page-hash">
        sha256{" "}
        {read.markdownUrl ? (
          <a href={read.markdownUrl} target="_blank" rel="noreferrer">
            {read.sha256.slice(0, 12)}…
          </a>
        ) : (
          `${read.sha256.slice(0, 12)}…`
        )}
        {read.changedFrom !== undefined && <> · changed since {when(read.changedFrom)}</>}
      </p>
    </div>
  ) : null;

  let body;
  if (read.outcome === "reading") {
    body =
      Date.now() - read.capturedAt < STALE_MS ? (
        <p className="try-read">Reading HPD Online…</p>
      ) : (
        <p>HPD Online could not be read; nothing kept.</p>
      );
  } else if (read.outcome === "kept") {
    body = (
      <>
        <p>
          {site}, read by Firecrawl {when(read.capturedAt)}: {read.statusText}
          {read.statusDate ? `, ${read.statusDate}` : ""}
        </p>
        {dataFile}
        {kept}
      </>
    );
  } else if (read.outcome === "not_found") {
    body = (
      <>
        <p>
          Not found on {site}, read by Firecrawl {when(read.capturedAt)}. It lists open violations only.
        </p>
        {dataFile}
        {kept}
      </>
    );
  } else if (read.outcome === "busy") {
    body = <p>HPD Online was not read: Firecrawl's browsers were all busy, twice. Nothing kept.</p>;
  } else if (read.outcome === "capped") {
    body = <p>HPD Online was not read: {read.why ?? "the day's readings are used up"}.</p>;
  } else {
    body = read.sha256 ? (
      <>
        <p>
          {site}, read by Firecrawl {when(read.capturedAt)}: this repair's row could not be read from it{read.why ? ` (${read.why})` : ""}. The page is kept as it was served.
        </p>
        {kept}
      </>
    ) : (
      <p>HPD Online could not be read; nothing kept{read.why ? ` (${read.why})` : ""}.</p>
    );
  }
  return (
    <div className="try-city-page" data-outcome={read.outcome}>
      {body}
    </div>
  );
}
