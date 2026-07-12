import { Anybody, Manrope, Geist_Mono } from "next/font/google";
import Providers from "@/components/Providers";
import NotificationListener from "@/components/NotificationListener";
import GlobalHotkeyHelp from "@/components/GlobalHotkeyHelp";
import TooltipProvider from "@/components/TooltipProvider";
import MergeToastContainer from "@/components/MergeToastContainer";
import InputNeededToastContainer from "@/components/InputNeededToastContainer";
import PromptErrorToastContainer from "@/components/PromptErrorToastContainer";
import ToastContainer from "@/components/ToastContainer";
import DevToolsGate from "@/components/DevToolsGate";
import ReactScanInstrumentation from "@/components/ReactScanInstrumentation";
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
          {children}
          <NotificationListener />
          <MergeToastContainer />
          <InputNeededToastContainer />
          <PromptErrorToastContainer />
          <ToastContainer />

          <DevToolsGate />
          <ReactScanInstrumentation />
          <GlobalHotkeyHelp />
          <TooltipProvider />
        </Providers>
      </body>
    </html>
  );
}
