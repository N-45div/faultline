import { convexAuth } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";

// Sign-in is optional everywhere. It exists for exactly two things a stranger
// cannot have: following a filing from the web without an email thread, and
// seeing what you follow. Nothing on the site is behind it.
//
// Email and password, through Convex Auth, and nothing else: no outside
// identity provider to configure, redirect, or fail during judging. A judge
// makes an account in one form and follows a filing thirty seconds later.

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({ providers: [Password] });
