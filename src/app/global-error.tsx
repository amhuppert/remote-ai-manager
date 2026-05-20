"use client";

export const dynamic = "force-dynamic";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  return (
    <html lang="en">
      <body>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "100vh",
            fontFamily: "system-ui, sans-serif",
            color: "#e8edf4",
            background: "#0b1019",
            padding: "2rem",
          }}
        >
          <h1 style={{ fontSize: "1.4rem", marginBottom: "1rem" }}>
            Something went wrong
          </h1>
          {error.digest && (
            <p
              style={{
                fontFamily: "monospace",
                opacity: 0.6,
                fontSize: "0.8rem",
              }}
            >
              Error ID: {error.digest}
            </p>
          )}
          <button
            onClick={reset}
            style={{
              marginTop: "1rem",
              padding: "0.5rem 1rem",
              background: "#00e5ff",
              color: "#0b1019",
              border: "none",
              borderRadius: "4px",
              cursor: "pointer",
              fontWeight: 600,
            }}
            type="button"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
