import { useEffect, useState } from "react";
import Building from "./Building";
import SignIn from "./SignIn";
import Employer from "./Employer";
import Judge from "./Judge";
import Landing from "./Landing";
import { Privacy, Terms } from "./Legal";
import Nav from "./Nav";
import Receipts from "./Receipts";
import "./styles.css";

// Every string on these pages is read by a person who got a letter this month.
// No engine nouns: nothing here is a source, a diff, a snapshot or a job.

/** A malformed percent-escape in the path is a bad link, not a blank site. */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

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
  const isPrivacy = path === "/privacy";
  const isTerms = path === "/terms";
  const isLanding = !employerMatch && !buildingMatch && !isApp && !isJudge && !isSignIn && !isPrivacy && !isTerms;
  // The tab and the bookmark say where you are, not the repository's old name.
  useEffect(() => {
    const titles: [boolean, string][] = [
      [Boolean(employerMatch), `${safeDecode(employerMatch?.[1] ?? "").replace(/-/g, " ")} · Faultline`],
      [Boolean(buildingMatch), "Building record · Faultline"],
      [isApp, "Receipts · Faultline"],
      [isJudge, "Tour · Faultline"],
      [isSignIn, "Sign in · Faultline"],
      [isPrivacy, "Privacy · Faultline"],
      [isTerms, "Terms · Faultline"],
    ];
    document.title = titles.find(([on]) => on)?.[1] ?? "Faultline — the address that writes back";
  }, [path]);

  let body;
  // key: the employer page holds per-employer state (what the company said in
  // public). Without it, navigating from one employer to another reuses the
  // mounted component and shows the first company's words under the second
  // company's filing — the one thing this product must never do.
  if (employerMatch) body = <Employer key={safeDecode(employerMatch[1])} q={safeDecode(employerMatch[1])} onBack={() => go("/app")} />;
  else if (buildingMatch) body = <Building bbl={safeDecode(buildingMatch[1])} onBack={() => go("/app")} />;
  else if (isApp) body = <Receipts go={go} />;
  else if (isJudge) body = <Judge go={go} />;
  else if (isSignIn) body = <SignIn onDone={() => go("/app")} />;
  else if (isPrivacy) body = <Privacy />;
  else if (isTerms) body = <Terms />;
  else body = <Landing go={go} />;

  return (
    <>
      <Nav path={path} go={go} />
      <main className={isLanding ? "landing" : "container narrow"}>{body}</main>
    </>
  );
}
