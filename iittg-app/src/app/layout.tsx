import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Is It Time To Go?",
  description:
    "One score for whether now is a good time to take that trip — built from weather, prices, crowding and exchange rates.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="font-sans text-slate-100 antialiased">
        {children}
      </body>
    </html>
  );
}
