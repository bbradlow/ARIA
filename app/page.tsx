export default function Home() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 40, maxWidth: 640 }}>
      <h1>Activant Research Bot</h1>
      <p>This is a background service — there is no user-facing UI.</p>
      <ul>
        <li>
          Metrics dashboard: <code>/dashboard?token=METRICS_TOKEN</code>
        </li>
        <li>
          Inbound email webhook: <code>/api/email/inbound</code>
        </li>
        <li>
          Slack events webhook: <code>/api/slack/events</code>
        </li>
      </ul>
    </main>
  );
}
