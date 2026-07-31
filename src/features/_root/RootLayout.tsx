import { Anybody, Manrope, Geist_Mono } from "next/font/google";
import Providers from "@/components/Providers";
import NotificationListener from "@/components/NotificationListener";
import GlobalHotkeyHelp from "@/components/GlobalHotkeyHelp";
import { TooltipProvider as UiTooltipProvider } from "@/components/ui/Tooltip";
import ToastHost from "@/components/ToastHost";
import DevToolsGate from "@/components/DevToolsGate";
import ReactScanInstrumentation from "@/components/ReactScanInstrumentation";
import QuickTicketHost from "@/components/quick-ticket/QuickTicketHost";
import MergeDoneTicketPromptHost from "@/components/MergeDoneTicketPromptHost";
import {
  HotkeyProvider,
  HotkeyRouteReset,
} from "@/components/hotkeys/HotkeyProvider";
import "@/app/globals.css";

const anybody = Anybody({
  subsets: ["latin"],
  weight: ["400", "600", "800"],
  variable: "--font-anybody",
  display: "swap",
});

const manrope = Manrope({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700", "800"],
  variable: "--font-manrope",
  display: "swap",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-geist-mono",
  display: "swap",
});

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <html
      lang="en"
      className={`${anybody.variable} ${manrope.variable} ${geistMono.variable}`}
    >
      <head>
        <link
          rel="apple-touch-icon"
          sizes="180x180"
          href="/apple-touch-icon.png"
        />
        <link
          rel="icon"
          type="image/png"
          sizes="32x32"
          href="/favicon-32x32.png"
        />
        <link
          rel="icon"
          type="image/png"
          sizes="16x16"
          href="/favicon-16x16.png"
        />
        <link rel="manifest" href="/site.webmanifest" />
      </head>
      <body>
        <Providers>
          <HotkeyProvider>
            <HotkeyRouteReset />
            <UiTooltipProvider>
              {children}
              <QuickTicketHost />
            </UiTooltipProvider>
            <NotificationListener />
            <ToastHost />
            <MergeDoneTicketPromptHost />

            <DevToolsGate />
            <ReactScanInstrumentation />
            <GlobalHotkeyHelp />
          </HotkeyProvider>
        </Providers>
      </body>
    </html>
  );
}
