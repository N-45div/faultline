import { HPD_PAGES, SAMPLE_BBL } from "../engine/hpd";
import { INBOX, mailto } from "./Pricing";
import { SAMPLE_ASK } from "./AskCard";

// How it works, for a tenant, in plain words. Every sentence on this page is a
// claim about the code as it stands, and names nothing it cannot back:
//   the 70 days, and which repairs get them .... engine/hpd.ts (challengeDeadline,
//                                                certifiedLate, pickAsks)
//   how to challenge ............................ engine/hpd.ts, engine/shareLetter.ts
//   what is public .............................. convex/attest.ts (corroborated)
//   the letter to a helper ...................... engine/shareLetter.ts, convex/share.ts
//   what is read, and when ...................... engine/adapters/, convex/crons.ts,
//                                                convex/ingest/seed.ts, convex/cityPage.ts
//   "not found" and "not checked" ............... src/CityPage.tsx, convex/inbound.ts
//   the earlier-citation check .................. convex/history.ts, convex/wall.ts
// Change one of those and this page changes with it. The rule HPD states in its
// own words is "can close", never "closes": an inspector who goes back changes it.

const CITY_FILE = "https://data.cityofnewyork.us/Housing-Development/Housing-Maintenance-Code-Violations/wvxf-dwi5";
const SAMPLE_ADDRESS = SAMPLE_ASK.replace(/^ASK /, "");

const SECTIONS: [string, string][] = [
  ["who", "Who this is for"],
  ["certification", "What a certification means"],
  ["seventy", "The 70 days, and where they stop"],
  ["answer", "What saving an answer does"],
  ["challenge", "How to challenge a certification"],
  ["private", "What is private, and what is public"],
  ["helper", "How someone helping you sees the record"],
  ["data", "Where the information comes from"],
  ["states", "What \"not found\" and \"not checked\" mean"],
  ["limits", "What it does not cover yet"],
];

export default function HowItWorks({ go }: { go: (p: string) => void }) {
  const link = (to: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    go(to);
  };
  const n = (id: string) => SECTIONS.findIndex(([s]) => s === id) + 1;
  const h = (id: string) => SECTIONS[n(id) - 1][1];

  return (
    <div className="howto">
      <p className="crumbs">
        <a href="/" onClick={link("/")}>← Faultline</a>
      </p>

      <section className="tour-intro">
        <p className="kicker">How it works · for New York City tenants · no sign-in needed</p>
        <h1 className="lede-title">Your landlord told the city a repair is done. Here is what Faultline does about it.</h1>
        <p className="lede-sub">
          Faultline shows you each repair the owner told the city is done, asks you whether it is, and keeps your
          answer, dated, beside the city's own record. It does not file anything with the city for you. Each part is
          below, in plain words, with where it stops.
        </p>
        <nav className="ninety" aria-label="On this page">
          <p className="ninety-h">On this page</p>
          <ol>
            {SECTIONS.map(([id, title]) => (
              <li key={id}>
                <a href={`#${id}`}>{title}</a>
              </li>
            ))}
          </ol>
        </nav>
      </section>

      <section className="tour-step" id="who">
        <span className="num">{n("who")}</span>
        <h2 className="h2">{h("who")}</h2>
        <p>
          New York City tenants living with a repair the owner has told the city is done, and the people helping them:
          a tenant organiser, a lawyer, a relative.
        </p>
        <p>
          You don't need an account. Email <strong>ASK</strong> and your address to{" "}
          <a href={mailto("ASK ")}>{INBOX}</a>, or{" "}
          <a href="/try" onClick={link("/try")}>
            try it in your browser
          </a>{" "}
          with no sign-in.
        </p>
        <p className="fine">Faultline also reads state layoff files. This page is about housing.</p>
      </section>

      <section className="tour-step" id="certification">
        <span className="num">{n("certification")}</span>
        <h2 className="h2">{h("certification")}</h2>
        <p>
          When HPD, the city's housing agency, finds a problem in a building, it writes a violation with a number and a
          class: C is immediately hazardous, B hazardous, A non-hazardous. The owner has to fix it. A{" "}
          <strong>certification</strong> is the owner telling HPD the repair is done.
        </p>
        <p>
          In HPD's file it shows as <strong>NOV CERTIFIED ON TIME</strong>, or <strong>NOV CERTIFIED LATE</strong> when
          the owner certified after the date the notice set. It is the owner's word, not an inspector's. If HPD checks
          and finds it untrue, it stamps the certification <strong>FALSE CERTIFICATION</strong> or{" "}
          <strong>INVALID CERTIFICATION</strong>, in those words.
        </p>
      </section>

      <section className="tour-step" id="seventy">
        <span className="num">{n("seventy")}</span>
        <h2 className="h2">{h("seventy")}</h2>
        <p>
          When an owner certifies a repair on time, HPD's 70 days begin. When they run out, the city{" "}
          <strong>can</strong> close the violation on the owner's word, unless an inspector goes back. That is why
          Faultline asks you inside those 70 days, before the city can close it.
        </p>
        <ul className="howto-list">
          <li>
            <strong>It is not your deadline.</strong> It is when the city may close the violation. If the condition is
            still there afterwards, you can still report it through 311.
          </li>
          <li>
            <strong>It is "can close", not "will close".</strong> An inspector who goes back, or a certification HPD
            stamps FALSE or INVALID, changes what happens. The city's record, not our count, says when a violation is
            closed.
          </li>
          <li>
            <strong>Only one kind of violation gets a clock:</strong> one the owner certified on time (NOV CERTIFIED ON
            TIME). The day is 70 days from the certification date in the city's file, or from the status date when the
            file gives none.
          </li>
          <li>
            <strong>A late certification gets no clock.</strong> NOV CERTIFIED LATE is asked about for the same 70 days,
            but shown no day: we can't show from the city's file that the same clock applies, so we don't claim one.
          </li>
          <li>
            <strong>A violation the city closed itself</strong> (VIOLATION CLOSED) has no certification to challenge and
            no clock. One the owner has not certified has no clock either, and Faultline does not ask about it.
          </li>
        </ul>
        <p className="fine">
          <a href={HPD_PAGES.certification} target="_blank" rel="noreferrer">
            HPD's own explanation of certifying and clearing violations →
          </a>
        </p>
      </section>

      <section className="tour-step" id="answer">
        <span className="num">{n("answer")}</span>
        <h2 className="h2">{h("answer")}</h2>
        <p>
          Answer <strong>FIXED</strong>, <strong>STILL BROKEN</strong> or <strong>NOT SURE</strong>, or say it in your
          own words, and Faultline keeps it: dated, private, beside what the city's file said when you were asked and
          what it says now. Answer again later and that is a second dated answer, not an edit of the first.
        </p>
        <p>
          If you answered by email and HPD later stamps that certification FALSE or INVALID, we email you, with both
          dates.
        </p>
        <p>
          <strong>Saving an answer does not file anything with HPD.</strong> Faultline does not send it to HPD, and it
          does not send an inspector. Only you can ask for that, the way the next section says.
        </p>
      </section>

      <section className="tour-step" id="challenge">
        <span className="num">{n("challenge")}</span>
        <h2 className="h2">{h("challenge")}</h2>
        <ol className="howto-list">
          <li>Call 311, or use nyc.gov/311.</li>
          <li>Give the violation number. Faultline shows it on every repair it lists, after the #.</li>
          <li>Say the condition the owner certified is still there.</li>
        </ol>
        <p>
          HPD says a tenant may challenge a certification, and that a challenge triggers an audit inspection. It publishes
          no form for it; 311 is the way in.
        </p>
        <p className="fine">
          If the city closed the violation itself, there is no certification to challenge. If the condition is still
          there, report it again through 311 or nyc.gov/311 and describe it.
        </p>
      </section>

      <section className="tour-step" id="private">
        <span className="num">{n("private")}</span>
        <h2 className="h2">{h("private")}</h2>
        <p>
          <strong>Private:</strong> your answers, your words, and any note or photo you send. They are on your own page,
          which only the link in your email opens. In the browser trial, they are kept on the trial's own page, which
          only your browser can open.
        </p>
        <p>
          Your answer leaves that page in two ways only: a building's public page may say that someone said STILL
          BROKEN once the city agrees (below), and a letter you choose to send a helper carries your answer in one word.
        </p>
        <p>
          <strong>Public:</strong> a building's page shows the city's records for it, every version we read, dated. It
          also shows how many answers are kept for the building, as a number with no words.
        </p>
        <p>
          A building's page says what someone answered only once the city's own record agrees: they said STILL BROKEN, and
          afterwards HPD stamped that certification FALSE or INVALID. Even then it shows the day they said it and the
          city's stamp, not their words and not who they are.
        </p>
        <p className="fine">
          What is said in the browser trial on /try is never counted on a public page: not in that number, and not
          beside the city's stamp.
        </p>
      </section>

      <section className="tour-step" id="helper">
        <span className="num">{n("helper")}</span>
        <h2 className="h2">{h("helper")}</h2>
        <p>
          On{" "}
          <a href="/try" onClick={link("/try")}>
            /try
          </a>
          , once you have answered a repair, you can name one person helping you. Faultline's inbox, {INBOX}, writes them
          one letter. It holds:
        </p>
        <ul className="howto-list">
          <li>
            the city's record for that repair: its number and class, the city's description with the apartment left
            out, its status and date, and HPD's 70 days where they apply;
          </li>
          <li>your answer in one word, FIXED, STILL BROKEN or NOT SURE, and the day you gave it;</li>
          <li>a link to the city's own row, and how a tenant challenges a certification.</li>
        </ul>
        <p>
          It never holds anything you typed, and it says so. If they reply to it, their reply shows under it on /try.
          Faultline does not write back to them, and if they reply STOP, that address gets nothing more.
        </p>
        <p className="fine">One letter a day to any one address, and three a day from one page.</p>
      </section>

      <section className="tour-step" id="data">
        <span className="num">{n("data")}</span>
        <h2 className="h2">{h("data")}</h2>
        <ul className="howto-list">
          <li>
            <strong>HPD's housing violations file</strong> on NYC Open Data (dataset wvxf-dwi5), read on a schedule every
            few hours for the buildings we hold. Ask about a building we don't hold yet and we find it in that file by its
            address and start reading it. Every version we read is kept, dated, so when the city overwrites a row, the one
            it replaced is still here.{" "}
            <a href={CITY_FILE} target="_blank" rel="noreferrer">
              The city's file →
            </a>
          </li>
          <li>
            <strong>HPD Online</strong>, the city's website for a building. When someone answers about a repair,
            Firecrawl opens HPD Online's violations page for that building, searches it for the number, and keeps a copy
            of what it showed. On /try it appears under the answered repair, beside the file's line; neither is said to
            be the other.
          </li>
          <li>
            <strong>One count a day</strong> from the same HPD file: the last 30 days of certifications, and of ones
            stamped FALSE or INVALID, on the home page.
          </li>
          <li>
            <strong>Nine other public files</strong>, read the same way: New York City's restaurant inspection results,
            and the layoff notice files of New York, California, Maryland, Colorado, North Carolina, Virginia, New Jersey
            and Wisconsin. Ten files in all.
          </li>
        </ul>
      </section>

      <section className="tour-step" id="states">
        <span className="num">{n("states")}</span>
        <h2 className="h2">{h("states")}</h2>
        <ul className="howto-list">
          <li>
            <strong>"Not found on HPD Online"</strong>: the building's page on HPD Online was read and searched for
            the number, and it listed nothing. HPD Online lists open violations only, so one that has closed is not there. It is not proof of
            anything about the repair; the city's file line is shown with it.
          </li>
          <li>
            <strong>Not checked</strong>, which the site says as <strong>"HPD Online was not read"</strong> or{" "}
            <strong>"could not be read"</strong>: we didn't look, or the page didn't come back readable. Firecrawl's
            browsers were busy, the day's readings were used up, or the page was not what we asked for. It says nothing
            about the repair either way.
          </li>
          <li>
            <strong>"We don't hold … yet"</strong>: nobody had asked about that building, so we had not read it. It is
            being read now. It does not mean the building has no violations.
          </li>
          <li>
            <strong>"Nothing to ask"</strong>: none of the owner's certifications we hold for the building is inside its
            70 days. The building can still have open violations; its page lists every record we hold.
          </li>
          <li>
            <strong>No "cited before" line</strong> under a repair means we did not find, or did not check, an earlier
            citation of the same condition under another number. It is not a clean record.
          </li>
          <li>
            <strong>"Not verified lately"</strong>, on the tour: a file we have not read in six hours, or whose last
            read failed.
          </li>
        </ul>
      </section>

      <section className="tour-step" id="limits">
        <span className="num">{n("limits")}</span>
        <h2 className="h2">{h("limits")}</h2>
        <ul className="howto-list">
          <li>
            <strong>Not every building.</strong> HPD's file is read for the buildings we hold, not the whole city. Ask
            about yours and it is added.
          </li>
          <li>
            <strong>Three repairs a reply, at most:</strong> the owner's certifications still inside their 70 days,
            newest first.
          </li>
          <li>
            <strong>The "cited before" check</strong> runs once a day, for the sample building only:{" "}
            <a href={`/b/${SAMPLE_BBL}`} onClick={link(`/b/${SAMPLE_BBL}`)}>
              {SAMPLE_ADDRESS}
            </a>
            {"."}
          </li>
          <li>
            <strong>HPD Online</strong> is read at most three times a day for one person and forty a day in all. A
            repair read in the last six hours shows that reading again.
          </li>
          <li>
            <strong>Phone calls</strong> ring US and Indian numbers only, and one number at most twice a day. The newer
            way of finishing a call, as a Convex Workflow, is installed but switched off on the live site; calls finish
            the way they always have.
          </li>
          <li>
            <strong>The browser trial</strong> cannot follow a building or email you. It lives in your browser.
          </li>
        </ul>
        <p className="tour-ctas">
          <a className="cta primary" href="/try" onClick={link("/try")}>
            Try it in your browser, no sign-in →
          </a>
          <a className="cta" href={HPD_PAGES.certification} target="_blank" rel="noreferrer">
            HPD's own explanation →
          </a>
        </p>
      </section>
    </div>
  );
}
