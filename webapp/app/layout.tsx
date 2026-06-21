import type { Metadata } from "next";
import "./globals.css";
import { ExtensionBridgeMount } from "@/components/extension-bridge-mount";

export const metadata: Metadata = {
  title: "Gemini Chat Archive",
  description:
    "Import, read, and search your exported Google Gemini conversations — keyword, fuzzy, and on-device semantic search. Export to EPUB.",
};

// Set the theme class before paint to avoid a flash. When the user hasn't
// chosen explicitly, follow the OS preference.
const themeScript = `
(function(){
  try {
    var t = localStorage.getItem('theme');
    var prefersDark = !window.matchMedia || window.matchMedia('(prefers-color-scheme: dark)').matches;
    var dark = t ? t === 'dark' : prefersDark;
    document.documentElement.classList.toggle('dark', dark);
  } catch(e) { document.documentElement.classList.add('dark'); }
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="font-sans antialiased">
        <a href="#main-content" className="skip-link">
          Skip to content
        </a>
        <ExtensionBridgeMount />
        {children}
      </body>
    </html>
  );
}
