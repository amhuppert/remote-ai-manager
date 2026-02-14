import type { Metadata } from "next";
import { Anybody, Manrope, Geist_Mono } from "next/font/google";
import "./globals.css";

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

export const metadata: Metadata = {
  title: "CSM — Ground Control",
  description: "Claude Session Manager — Remote coding session control",
};

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
      <body>{children}</body>
    </html>
  );
}
