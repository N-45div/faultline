import { useEffect, useState } from "react";
import Building from "./Building";
import Employer from "./Employer";
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
  const isLanding = !employerMatch && !buildingMatch && !isApp;

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

  let body;
  if (employerMatch) body = <Employer q={decodeURIComponent(employerMatch[1])} onBack={() => go("/app")} />;
  else if (buildingMatch) body = <Building bbl={decodeURIComponent(buildingMatch[1])} onBack={() => go("/app")} />;
  else if (isApp) body = <Receipts go={go} />;
  else body = <Landing go={go} />;

  return (
    <>
      <header className="topbar">
        <div className="container bar">
          <div className="brand">{link("/", "Notice")}</div>
          <nav className="nav" aria-label="Main">
            {link("/app", "Receipts")}
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
