import type {Metadata} from "next";
import type {ReactNode} from "react";
import {Inter, JetBrains_Mono} from "next/font/google";
import {Providers} from "@/components/Providers";
import {noFlashThemeScript} from "@/components/ui/ThemeToggle";
import "@/app/globals.css";

const inter = Inter({subsets: ["latin"], variable: "--font-inter", display: "swap"});
const jetbrainsMono = JetBrains_Mono({subsets: ["latin"], variable: "--font-jetbrains-mono", display: "swap"});

export const metadata: Metadata = {
  title: "dogtag-vet",
  description: "Self-deployable DogTag vet platform: clients, pets, tags, appointments, payments.",
};

export default function RootLayout({children}: {children: ReactNode}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Runs synchronously, before paint, to avoid a theme flash. */}
        <script dangerouslySetInnerHTML={{__html: noFlashThemeScript}} />
      </head>
      <body className={`${inter.variable} ${jetbrainsMono.variable} font-sans`} suppressHydrationWarning>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
