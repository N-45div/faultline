import { useEffect, useState } from "react";
import { Authenticated, Unauthenticated } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import Building from "./Building";
import SignIn from "./SignIn";
import Employer from "./Employer";
import Judge from "./Judge";
import Landing from "./Landing";
import Receipts from "./Receipts";
import { INBOX, mailto } from "./Pricing";
import "./styles.css";

// Every string on these pages is read by a person who got a letter this month.
// No engine nouns: nothing here is a source, a diff, a snapshot or a job.

function usePath(): [string, (p: string) => void] {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const go = (p: string) => {
    window.history.pushState({}, "", p);
    setPath(p);
    window.scrollTo(0, 0);
  };
  return [path, go];
}

export default function App() {
  const [path, go] = usePath();
  const employerMatch = /^\/e\/([^/]+)/.exec(path);
  const buildingMatch = /^\/b\/([^/]+)/.exec(path);
  const isApp = path === "/app" || path.startsWith("/app/");
  const isJudge = path === "/judge" || path === "/tour";
  const isSignIn = path === "/signin";
  const isLanding = !employerMatch && !buildingMatch && !isApp && !isJudge && !isSignIn;
  const { signOut } = useAuthActions();

  const link = (to: string, label: string) => (
    <a
      href={to}
      className={path === to ? "active" : undefined}
      onClick={(e) => {
        e.preventDefault();
        go(to);
      }}
    >
      {label}
    </a>
  );

  // The tab and the bookmark say where you are, not the repository's old name.
  useEffect(() => {
    const titles: [boolean, string][] = [
      [Boolean(employerMatch), `${decodeURIComponent(employerMatch?.[1] ?? "").replace(/-/g, " ")} · Notice`],
      [Boolean(buildingMatch), "Building record · Notice"],
      [isApp, "Receipts · Notice"],
      [isJudge, "Tour · Notice"],
      [isSignIn, "Sign in · Notice"],
    ];
    document.title = titles.find(([on]) => on)?.[1] ?? "Notice — the address that writes back";
  }, [path]);

  let body;
  if (employerMatch) body = <Employer q={decodeURIComponent(employerMatch[1])} onBack={() => go("/app")} />;
  else if (buildingMatch) body = <Building bbl={decodeURIComponent(buildingMatch[1])} onBack={() => go("/app")} />;
  else if (isApp) body = <Receipts go={go} />;
  else if (isJudge) body = <Judge go={go} />;
  else if (isSignIn) body = <SignIn onDone={() => go("/app")} />;
  else body = <Landing go={go} />;

  return (
    <>
      <header className="topbar">
        <div className="container bar">
          <div className="brand">{link("/", "Notice")}</div>
          <nav className="nav" aria-label="Main">
            {link("/app", "Receipts")}
            {link("/judge", "Tour")}
            <Unauthenticated>{link("/signin", "Sign in")}</Unauthenticated>
            <Authenticated>
              <a
                href="/signin"
                onClick={(e) => {
                  e.preventDefault();
                  void signOut().then(() => go("/"));
                }}
              >
                Sign out
              </a>
            </Authenticated>
            <a
              href="/#pricing"
              onClick={(e) => {
                e.preventDefault();
                go("/");
                setTimeout(() => document.getElementById("pricing")?.scrollIntoView({ behavior: "smooth" }), 60);
              }}
            >
              Pricing
            </a>
            <a className="nav-cta" href={mailto("Spirit Airlines")}>
              {INBOX}
            </a>
          </nav>
        </div>
      </header>
      <main className={isLanding ? "landing" : "container narrow"}>{body}</main>
    </>
  );
}
