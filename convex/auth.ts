import { convexAuth } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";
import Google from "@auth/core/providers/google";

// Sign-in is optional everywhere. It exists for exactly two things a stranger
// cannot have: following a filing from the web without an email thread, and
// seeing what you follow. Nothing on the site is behind it.
//
// Email + password works with no outside service. Google is offered only once
// the deployment holds a client id and secret; until then the button does not
// exist, rather than existing and failing.

const providers = [Password];
if (process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET) providers.push(Google as never);

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({ providers });
