import localFont from "next/font/local";
import Providers from "@/components/Providers";
import NotificationListener from "@/components/NotificationListener";
import GlobalHotkeyHelp from "@/components/GlobalHotkeyHelp";
import { TooltipProvider as UiTooltipProvider } from "@/components/ui/Tooltip";
import ToastHost from "@/components/ToastHost";
import DevToolsGate from "@/components/DevToolsGate";
import ReactScanInstrumentation from "@/components/ReactScanInstrumentation";
import QuickTicketHost from "@/components/quick-ticket/QuickTicketHost";
import VoiceQuickCaptureHost from "@/components/notepad-capture/VoiceQuickCaptureHost";
import MergeDoneTicketPromptHost from "@/components/MergeDoneTicketPromptHost";
import {
  HotkeyProvider,
  HotkeyRouteReset,
} from "@/components/hotkeys/HotkeyProvider";
import "@/app/globals.css";

const anybody = localFont({
  src: "./fonts/Anybody.woff2",
  weight: "400 800",
  variable: "--font-anybody",
  display: "swap",
});

const manrope = localFont({
  src: "./fonts/Manrope.woff2",
  weight: "300 800",
  variable: "--font-manrope",
  display: "swap",
});

const geistMono = localFont({
  src: "./fonts/GeistMono.woff2",
  weight: "300 700",
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
        <meta name="theme-color" content="#06090f" />
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
              <VoiceQuickCaptureHost />
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
