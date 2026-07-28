export const metadata = {
  title: 'SAV Dispatch — 3GCOM Haddaouia',
  description: 'Distribution quotidienne des tickets SAV',
};

export default function RootLayout({ children }) {
  return (
    <html lang="fr">
      <body style={{ margin: 0, fontFamily: "'Segoe UI', system-ui, sans-serif", background: '#F2F4F8' }}>
        {children}
      </body>
    </html>
  );
}
