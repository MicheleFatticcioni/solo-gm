import type { NextAuthConfig } from "next-auth";

// Config condivisa tra middleware (edge) e server: niente import del DB qui.
export const authConfig = {
  // Serve self-hosted (no Vercel): senza questo, `next start` in produzione
  // rifiuta le richieste con UntrustedHost perché non conosce l'host pubblico.
  trustHost: true,
  pages: {
    signIn: "/login",
  },
  session: {
    strategy: "jwt",
  },
  callbacks: {
    // Con strategy jwt il sub del token è l'id utente: lo esponiamo in sessione
    // così API routes e pagine non devono rifare la lookup per email.
    session({ session, token }) {
      if (session.user && token.sub) {
        session.user.id = token.sub;
      }
      return session;
    },
    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = !!auth?.user;
      const isLoginPage = nextUrl.pathname.startsWith("/login");

      if (isLoginPage) {
        if (isLoggedIn) {
          return Response.redirect(new URL("/dashboard", nextUrl));
        }
        return true;
      }
      return isLoggedIn;
    },
  },
  providers: [],
} satisfies NextAuthConfig;
