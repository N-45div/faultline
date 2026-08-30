import { useEffect, useState } from "react";
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
  const isApp = path === "/app" || path.startsWith("/app/");

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

  return (
    <main className="page">
      <header className="masthead">
        <div className="brand">{link("/", "Notice")}</div>
        <nav className="nav" aria-label="Main">
          {link("/app", "Receipts")}
          <a href="/#pricing" onClick={(e) => { e.preventDefault(); go("/"); setTimeout(() => document.getElementById("pricing")?.scrollIntoView({ behavior: "smooth" }), 50); }}>
            Pricing
          </a>
          <a href={mailto("Spirit Airlines")}>{INBOX}</a>
        </nav>
      </header>

      {employerMatch ? (
        <Employer q={decodeURIComponent(employerMatch[1])} onBack={() => go("/app")} />
      ) : isApp ? (
        <Receipts go={go} />
      ) : (
        <Landing go={go} />
      )}
    </main>
  );
}
