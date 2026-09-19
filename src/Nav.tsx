import { useEffect, useRef, useState } from "react";
import { Authenticated, Unauthenticated, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "../convex/_generated/api";
import { INBOX, mailto } from "./Pricing";
import { toSlug } from "./Receipts";

// The bar. Three zones, the way people expect them: where you are (left),
// what you can look up (middle), who you are and how to reach us (right).
// Everything is reachable by keyboard, the menu closes on Escape, and the
// address copies itself because that is what people actually want from it.

const LINKS: [string, string][] = [
  ["/app", "Receipts"],
  ["/files", "Files"],
  ["/scorecard", "Scorecard"],
  ["/try", "Try it"],
  ["/judge", "Tour"],
  ["/pricing", "Pricing"],
];

export default function Nav({ path, go }: { path: string; go: (p: string) => void }) {
  const { signOut } = useAuthActions();
  const me = useQuery(api.follows.me, {});
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  const [q, setQ] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);

  // Route changes close everything; Escape closes everything; a click outside
  // closes the account menu.
  useEffect(() => {
    setOpen(false);
    setMenu(false);
  }, [path]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setMenu(false);
      }
    };
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, []);

  const nav = (to: string, e: React.MouseEvent) => {
    e.preventDefault();
    if (to === "/pricing") {
      go("/");
      setTimeout(() => document.getElementById("pricing")?.scrollIntoView({ behavior: "smooth" }), 60);
      return;
    }
    go(to);
  };
  const current = (to: string) =>
    to === "/pricing"
      ? false
      : path === to ||
        (to === "/app" && (path.startsWith("/e/") || path.startsWith("/b/"))) ||
        (to === "/files" && (path.startsWith("/file/") || path.startsWith("/commit/") || path === "/deleted"));

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(INBOX);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      window.location.href = mailto("");
    }
  };

  const search = (e: React.FormEvent) => {
    e.preventDefault();
    const s = q.trim();
    if (!s) return;
    setQ("");
    go(/^\d{10}$/.test(s) ? `/b/${s}` : `/e/${toSlug(s)}`);
  };

  const initial = (me?.email ?? "?").slice(0, 1).toUpperCase();

  return (
    <header className={`topbar${open ? " open" : ""}`}>
      <div className="container bar">
        <a className="brand" href="/" onClick={(e) => nav("/", e)} aria-label="Faultline, home">
          <span className="wordmark">Faultline</span>
          <span className="tagline">the address that writes back</span>
        </a>

        <nav className="links" aria-label="Main">
          {LINKS.map(([to, label]) => (
            <a key={to} href={to} onClick={(e) => nav(to, e)} aria-current={current(to) ? "page" : undefined}>
              {label}
            </a>
          ))}
        </nav>

        {path !== "/" && (
          <form className="barsearch" role="search" onSubmit={search}>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Look up a company or a NYC address"
              aria-label="Look up a company or a New York City address"
            />
          </form>
        )}

        <div className="actions">
          <button type="button" className={`address${copied ? " copied" : ""}`} onClick={copy} title="Copy the address">
            <span className="addr">{INBOX}</span>
            <span className="hint">{copied ? "Copied" : "copy"}</span>
          </button>
          <a className="cta primary small" href={mailto("Spirit Airlines")}>
            Email us
          </a>

          <Unauthenticated>
            <a className="signin" href="/signin" onClick={(e) => nav("/signin", e)}>
              Sign in
            </a>
          </Unauthenticated>
          <Authenticated>
            <div className="account" ref={menuRef}>
              <button
                type="button"
                className="avatar"
                aria-haspopup="menu"
                aria-expanded={menu}
                onClick={() => setMenu((m) => !m)}
                title={me?.email ?? "Account"}
              >
                {initial}
              </button>
              {menu && (
                <div className="menu" role="menu">
                  <p className="who">{me?.email ?? "Signed in"}</p>
                  <a role="menuitem" href="/app" onClick={(e) => nav("/app", e)}>
                    What you follow
                  </a>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenu(false);
                      void signOut().then(() => go("/"));
                    }}
                  >
                    Sign out
                  </button>
                </div>
              )}
            </div>
          </Authenticated>

          <button
            type="button"
            className="burger"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            aria-controls="mobile-menu"
            onClick={() => setOpen((o) => !o)}
          >
            <span />
            <span />
            <span />
          </button>
        </div>
      </div>

      {open && (
        <div id="mobile-menu" className="sheet container">
          <form className="barsearch" role="search" onSubmit={search}>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Look up a company or a NYC address" aria-label="Look up" />
          </form>
          {LINKS.map(([to, label]) => (
            <a key={to} href={to} onClick={(e) => nav(to, e)} aria-current={current(to) ? "page" : undefined}>
              {label}
            </a>
          ))}
          <a className="cta primary" href={mailto("Spirit Airlines")}>
            Email {INBOX}
          </a>
          <Unauthenticated>
            <a href="/signin" onClick={(e) => nav("/signin", e)}>
              Sign in
            </a>
          </Unauthenticated>
          <Authenticated>
            <button type="button" className="linklike" onClick={() => void signOut().then(() => go("/"))}>
              Sign out{me?.email ? ` (${me.email})` : ""}
            </button>
          </Authenticated>
        </div>
      )}
    </header>
  );
}
