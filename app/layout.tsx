import type { Metadata, Viewport } from "next";
import Script from "next/script";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import ThemeToggle from "@/components/theme/ThemeToggle";
import { LayoutStateProvider } from "@/components/layout/LayoutState";
import { LeftSidebarToggle, RightSidebarToggle } from "@/components/layout/SidebarControls";
import { AgentPicker } from "@/components/layout/AgentPicker";
import { RestartButton } from "@/components/layout/RestartButton";
import { PushToggle } from "@/components/pwa/PushToggle";
import { ServiceWorkerRegister } from "@/components/pwa/ServiceWorkerRegister";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "paf · chat",
  description: "paf-ui — chat over the paf SSE transport",
  // iOS "Add to Home Screen": opens standalone (apple-icon.png is picked up by
  // the app/ file convention; manifest.ts covers Android/desktop).
  appleWebApp: { capable: true, title: "paf", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0f1115" },
  ],
};

// Runs before paint: restore the saved theme (or fall back to system), so the
// page never flashes the wrong theme. Applies the `.dark` class to <html>.
const themeScript = `
(function () {
  try {
    var t = localStorage.getItem("paf-ui-theme");
    var dark = t === "dark" || ((!t || t === "system") &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
    var d = document.documentElement;
    d.classList.toggle("dark", dark);
    d.style.colorScheme = dark ? "dark" : "light";
  } catch (e) {}
})();
`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-dvh overflow-hidden antialiased`}
      suppressHydrationWarning
    >
      <head />
      <body className="h-dvh overflow-hidden flex flex-col">
        {/* Runs before paint to restore the saved theme (anti-FOUC). beforeInteractive
            hoists this into <head> and runs before hydration. */}
        <Script
          id="theme-init"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: themeScript }}
        />
        <ServiceWorkerRegister />
        <LayoutStateProvider>
          <header className="flex items-center justify-between border-b px-4 py-2">
            <div className="flex items-center gap-2">
              <LeftSidebarToggle />
              <AgentPicker />
              <RestartButton />
            </div>
            <div className="flex items-center gap-1">
              <RightSidebarToggle />
              <PushToggle />
              <ThemeToggle />
            </div>
          </header>
          <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        </LayoutStateProvider>
      </body>
    </html>
  );
}
