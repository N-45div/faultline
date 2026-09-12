import { INBOX } from "./Pricing";

// Plain words about what we keep and what we never do. Written to be read,
// not to be skipped: it says the same things the product says everywhere else.

export function Privacy() {
  return (
    <>
      <p className="kicker">Privacy</p>
      <h1 className="lede-title">What we keep, and what we never do.</h1>
      <p className="fine">Last changed 2 September 2026. Questions: {INBOX}.</p>

      <h2 className="h2">What we hold about you</h2>
      <p>
        If you email {INBOX}, we keep the email address you wrote from, the subject and text of what you sent, when it
        arrived, and what we sent back. If you reply FOLLOW, we keep that you follow a filing so we can tell you when it
        changes. If you create an account, we keep your email address and a password we cannot read. That is all.
      </p>

      <h2 className="h2">Letters you send us</h2>
      <p>
        A pasted or attached termination letter is read once by a language model to pull out what it states — the
        employer, the dates, the stated reason, the release deadline. We keep the result, keyed to a hash of the
        letter's content, so the same letter is never read twice. We do not use your letter to train anything, we do not
        sell it, and we do not show it to anyone else. Text is screened by a free moderation check before any paid
        model call.
      </p>

      <h2 className="h2">Public records</h2>
      <p>
        Everything we publish comes from files governments publish: state layoff notices and New York City housing
        records. We keep dated copies because the agencies overwrite theirs. We do not publish information about
        private individuals: where a government file names a contact person, that column is read and dropped before
        anything is stored.
      </p>

      <h2 className="h2">Who else touches it</h2>
      <p>
        The service runs on Convex (database and hosting), AgentMail (the email address), and OpenAI (reading letters
        and one web search per employer). Each sees only what it needs to do its job. We hold no advertising trackers
        and set no third-party cookies.
      </p>

      <h2 className="h2">Stopping</h2>
      <p>
        Reply STOP to any email and we will not email you again; that is honoured before every other rule we have. To
        have what we hold about you deleted, email {INBOX} from the address in question and say so.
      </p>
    </>
  );
}

export function Terms() {
  return (
    <>
      <p className="kicker">Terms</p>
      <h1 className="lede-title">What this is, and what it is not.</h1>
      <p className="fine">Last changed 2 September 2026. Questions: {INBOX}.</p>

      <h2 className="h2">Not legal advice</h2>
      <p>
        Faultline shows you what an employer or a landlord told the government, dated, beside the statute that applies.
        It never says whether anything was lawful. Employers can claim exceptions and agencies correct records; those
        are questions for a lawyer. What you get here is the dated proof you bring them.
      </p>

      <h2 className="h2">Accuracy</h2>
      <p>
        We read government files as they are published and keep every version we have seen. The files themselves
        contain typos, ranges and corrections, and we say so where we can. Every receipt links to the government's own
        page so you can check it yourself. We may be wrong; the record is the record.
      </p>

      <h2 className="h2">Use</h2>
      <p>
        Receipts, follows and evidence packs are free while we launch. Do not use the service to harass anyone, to
        republish information about private individuals, or to send it mail it did not ask for. We may decline to
        answer an address that does either.
      </p>

      <h2 className="h2">Changes</h2>
      <p>These terms and the privacy note above change by being edited here, with the date at the top.</p>
    </>
  );
}
