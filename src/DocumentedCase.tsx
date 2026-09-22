// A documented case, from the city's own file: two repairs at the sample
// building where the owner certified the roaches gone and the city checked and
// recorded FALSE CERTIFICATION. It is history, read from the city's API on 22
// September 2026 and written down here as it read; the link is the city's own
// query, so anyone can see the rows as they read today. No tenant's answer is
// shown or made up: this is the shape of the record Faultline keeps beside one.

const ROWS = "https://data.cityofnewyork.us/resource/wvxf-dwi5.json?$select=violationid,class,novdescription,inspectiondate,novissueddate,certifieddate,currentstatus,currentstatusdate&$where=violationid%20in('19105968','19114310')";

const CASES: { id: string; where: string; lines: [string, string, string][] }[] = [
  {
    id: "19105968",
    where: "roaches in the compactor closet, 3rd floor · class C",
    lines: [
      ["2026-07-28", "The city", "cited it, after an inspection on 2026-07-24"],
      ["2026-08-12", "The owner", "certified it corrected"],
      ["2026-08-18", "The city", "recorded FALSE CERTIFICATION, six days later"],
    ],
  },
  {
    id: "19114310",
    where: "roaches in the compactor closet, 1st floor · class C",
    lines: [
      ["2026-07-31", "The city", "cited it, after an inspection on 2026-07-27"],
      ["2026-08-24", "The owner", "certified it corrected"],
      ["2026-08-29", "The city", "recorded FALSE CERTIFICATION, five days later"],
    ],
  },
];

export default function DocumentedCase() {
  return (
    <div className="doc-case">
      <p className="case-label">History · 155 Linden Boulevard, Brooklyn · the city's file as read on 22 September 2026</p>
      {CASES.map((c) => (
        <div key={c.id} className="doc-case-one">
          <p className="doc-case-head">
            <strong>#{c.id}</strong> · {c.where}
          </p>
          <ol className="case-sequence">
            {c.lines.map(([date, who, what]) => (
              <li key={date + who}>
                <time>{date}</time> <strong>{who}</strong> {what}
              </li>
            ))}
          </ol>
        </div>
      ))}
      <p className="fine">
        The owner's word, then the city's own finding, each dated. No tenant's answer is shown: this is the city's record
        alone, the one Faultline keeps a tenant's dated answer beside.{" "}
        <a href={ROWS} target="_blank" rel="noreferrer">
          The city's own rows ↗
        </a>
      </p>
    </div>
  );
}
