"use client";

import CraneControl from "./ServerFrontend";   // ✅ point to the real file

export default function Home() {
  return <CraneControl />;                     // ✅ render it
}
