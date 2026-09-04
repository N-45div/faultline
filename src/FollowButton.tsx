import { Authenticated, Unauthenticated, useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";

// The web's FOLLOW. Same table the inbox writes to, same one-a-day digest on
// the way out. Signed out, it says so instead of pretending.

export default function FollowButton({ subjectKey, label }: { subjectKey: string; label: string }) {
  const following = useQuery(api.follows.following, { subjectKey });
  const emailed = useQuery(api.follows.emailConfirmed, {});
  const follow = useMutation(api.follows.follow);
  const unfollow = useMutation(api.follows.unfollow);

  return (
    <p className="follow">
      <Authenticated>
        {following ? (
          <>
            <span className="muted">
              {emailed
                ? "You follow this. We'll email you when it changes, at most once a day."
                : "You follow this — it will show up here when it changes. To get it by email, send FOLLOW from that address to the inbox; we only write to an address that has written to us."}
            </span>{" "}
            <button type="button" className="linklike" onClick={() => void unfollow({ subjectKey })}>
              Stop following
            </button>
          </>
        ) : (
          <button type="button" className="cta" onClick={() => void follow({ subjectKey, label })}>
            Follow this filing
          </button>
        )}
      </Authenticated>
      <Unauthenticated>
        <span className="muted">
          To follow this from the web,{" "}
          <a href="/signin">sign in</a>. Or reply FOLLOW to any receipt by email — no account needed.
        </span>
      </Unauthenticated>
    </p>
  );
}
