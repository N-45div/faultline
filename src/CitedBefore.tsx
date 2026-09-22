import { citedBeforeLine, cityRowsUrl, dayName, type Earlier } from "../engine/conditionHistory";

// A repair the city cited before under another number, in the city's own
// dates (convex/history.ts), with a link to the city's rows for both. Drawn
// under a repair on /try and on a person's record. The record also says what
// the two were matched on, and what the match does not show.

export default function CitedBefore({ before, violationId, basis = false }: { before: Earlier; violationId: string; basis?: boolean }) {
  return (
    <div className="try-row-before">
      <p className="try-row-before-label">Cited before under a new number</p>
      <p>
        {citedBeforeLine(before)}{" "}
        <a href={cityRowsUrl([before.violationId, violationId])} target="_blank" rel="noreferrer">
          the city's rows for both →
        </a>
      </p>
      {basis && (
        <p className="cited-before-basis">
          Matched on the city's own rows: the same description, word for word, at the same apartment and story. #{before.violationId} was
          inspected on {dayName(before.inspectionDate)}, and certified or closed before #{violationId} was written up. The same words
          twice show the city wrote the condition up again; they do not show it was never fixed in between.
        </p>
      )}
    </div>
  );
}
