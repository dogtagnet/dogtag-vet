import type {Metadata} from "next";
import type {ReactNode} from "react";
import {Inter, JetBrains_Mono} from "next/font/google";
import {Providers} from "@/components/Providers";
import {PublicConfigInitScript} from "@/components/PublicConfigInitScript";
import {noFlashThemeScript} from "@/components/ui/ThemeToggle";
import "@/app/globals.css";

const inter = Inter({subsets: ["latin"], variable: "--font-inter", display: "swap"});
const jetbrainsMono = JetBrains_Mono({subsets: ["latin"], variable: "--font-jetbrains-mono", display: "swap"});

export const metadata: Metadata = {
  title: "dogtag-vet",
  description: "Self-deployable DogTag vet platform: clients, pets, tags, appointments, payments.",
};

// PublicConfigInitScript (in <head> below) reads this server process's real env on every request
// and hands it to the browser. A statically prerendered route would bake whatever env happened to
// be present at `next build` time into that route's cached HTML forever - the exact bug this
// component exists to fix (WP4.17 D2), just relocated from the JS bundle to the HTML shell.
// Forcing every route dynamic is the only way one built image serves every deployment's real
// protocol config correctly.
export const dynamic = "force-dynamic";

export default function RootLayout({children}: {children: ReactNode}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Runs synchronously, before paint, to avoid a theme flash. */}
        <script dangerouslySetInnerHTML={{__html: noFlashThemeScript}} />
        <PublicConfigInitScript />
      </head>
      <body className={`${inter.variable} ${jetbrainsMono.variable} font-sans`} suppressHydrationWarning>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
