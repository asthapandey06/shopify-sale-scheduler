/**
 * Friendly fallback page. Uses plain HTML (not Polaris components) because it
 * may render where App Bridge/Polaris scripts haven't loaded.
 */
export function ErrorPage({
  title,
  message,
  link = { href: "/app", label: "Back to your sales" },
}: {
  title: string;
  message: string;
  /** Where to go next; the in-app default needs a Shopify session, so public pages pass their own. */
  link?: { href: string; label: string };
}) {
  return (
    <main
      style={{
        fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        maxWidth: 560,
        margin: "64px auto",
        padding: "0 16px",
        color: "#303030",
        lineHeight: 1.5,
      }}
    >
      <h1 style={{ fontSize: 20, margin: "0 0 8px" }}>{title}</h1>
      <p style={{ margin: "0 0 16px" }}>{message}</p>
      <a href={link.href} style={{ color: "#005bd3" }}>
        {link.label}
      </a>
    </main>
  );
}
