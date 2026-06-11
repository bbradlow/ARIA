export const metadata = {
  title: "Activant Research Bot",
  description: "Slack bot that summarizes Activant Capital research newsletters.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
