"use client";

/**
 * Replaces the root layout when it is the layout itself that failed, so it gets
 * neither globals.css nor the theme class next-themes writes on <html>. Every
 * style here is therefore inline and self-contained, and the palette follows the
 * OS colour scheme rather than the app's stored preference.
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "2rem 1.25rem",
          background: "#fbf8f3",
          color: "#1b211e",
          colorScheme: "light dark",
          fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
          textAlign: "center",
        }}
      >
        <style>{`
          @media (prefers-color-scheme: dark) {
            body { background: #0c1211 !important; color: #e8efea !important; }
            .ge-panel { border-color: #232e2a !important; background: #131a18 !important; }
            .ge-muted { color: #9baaa3 !important; }
            .ge-action { background: #3fd6a4 !important; color: #06201b !important; }
          }
        `}</style>
        <div
          className="ge-panel"
          style={{
            maxWidth: "32rem",
            width: "100%",
            border: "1px solid #e4daca",
            background: "#fffdf9",
            borderRadius: "0.875rem",
            padding: "2.5rem 1.75rem",
          }}
        >
          <p style={{ margin: 0, fontSize: "0.75rem", letterSpacing: "0.16em", textTransform: "uppercase", color: "#8a6b18", fontWeight: 600 }}>
            Gift Planner
          </p>
          <h1 style={{ margin: "0.75rem 0 0", fontSize: "1.75rem", fontFamily: "ui-serif, Georgia, serif", fontWeight: 600 }}>
            The app failed to start
          </h1>
          <p className="ge-muted" style={{ margin: "0.75rem 0 0", fontSize: "0.875rem", lineHeight: 1.6, color: "#5a655f" }}>
            Reloading usually clears this. {error.digest ? `Reference: ${error.digest}` : null}
          </p>
          {/* A hard navigation, not a client-side one: the React tree that
              would handle a <Link> is the thing that just failed. */}
          <button
            type="button"
            className="ge-action"
            // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- a client-side push needs the router that just crashed; this must be a full document load
            onClick={() => window.location.assign("/")}
            style={{
              marginTop: "1.5rem",
              minHeight: "3rem",
              padding: "0 1.25rem",
              border: "none",
              borderRadius: "0.625rem",
              background: "#0f6b4f",
              color: "#fbf8f3",
              fontWeight: 600,
              fontSize: "0.875rem",
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            Reload the app
          </button>
        </div>
      </body>
    </html>
  );
}
