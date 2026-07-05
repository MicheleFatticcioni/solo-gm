import NextAuth from "next-auth";

import { authConfig } from "@/auth.config";

// Proxy (il "middleware" di Next 16): protegge tutto tranne /login
// (gestita dal callback `authorized`), le route di Auth.js e gli asset statici.
export default NextAuth(authConfig).auth;

export const config = {
  matcher: ["/((?!api/auth|_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
