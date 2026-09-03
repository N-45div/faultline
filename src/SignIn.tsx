import { useState } from "react";
import { useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "../convex/_generated/api";

// Email and password, nothing else asked. Google appears here once the
// deployment holds a client id; until then the button does not exist.

export default function SignIn({ onDone }: { onDone: () => void }) {
  const { signIn } = useAuthActions();
  const [flow, setFlow] = useState<"signIn" | "signUp">("signIn");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const google = useQuery(api.follows.googleEnabled, {});

  return (
    <section className="hero signin" aria-label="Sign in">
      <p className="kicker">{flow === "signIn" ? "Sign in" : "Create an account"}</p>
      <h2>{flow === "signIn" ? "Follow filings from the web." : "One email, one password."}</h2>
      <p className="fine">
        Nothing on this site needs an account. Signing in only lets you follow a filing without an email thread, and
        see what you follow. We never sell information about anyone.
      </p>
      {google && (
        <>
          {/* A rejected sign-in must say so: discarded, it reads as a dead button. */}
          <button
            type="button"
            className="cta google"
            onClick={() => {
              setError(null);
              signIn("google").catch(() => setError("Couldn't start Google sign-in. Use an email and password instead."));
            }}
          >
            Continue with Google
          </button>
          <p className="fine or">or with email</p>
        </>
      )}
      <form
        className="signin-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          const form = new FormData(e.currentTarget);
          form.set("flow", flow);
          try {
            await signIn("password", form);
            onDone();
          } catch (err) {
            const msg = String((err as Error)?.message ?? err);
            setError(
              /InvalidAccountId|InvalidSecret|Invalid password|credentials/i.test(msg)
                ? flow === "signIn"
                  ? "That email and password don't match."
                  : "Couldn't create that account — the password needs at least eight characters."
                : "Something went wrong. Try again.",
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        <input name="email" type="email" placeholder="you@example.com" autoComplete="email" required />
        <input
          name="password"
          type="password"
          placeholder={flow === "signUp" ? "at least 8 characters" : "password"}
          autoComplete={flow === "signUp" ? "new-password" : "current-password"}
          required
          minLength={8}
        />
        <button type="submit" className="cta primary" disabled={busy}>
          {busy ? "One moment…" : flow === "signIn" ? "Sign in" : "Create account"}
        </button>
      </form>
      {error && <p className="fine error">{error}</p>}
      <p className="fine">
        {flow === "signIn" ? "New here? " : "Already have an account? "}
        <button type="button" className="linklike" onClick={() => setFlow(flow === "signIn" ? "signUp" : "signIn")}>
          {flow === "signIn" ? "Create an account" : "Sign in instead"}
        </button>
      </p>
    </section>
  );
}
