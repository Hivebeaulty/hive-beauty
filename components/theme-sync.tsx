"use client";
// No modo Automático, acompanha a troca de tema do celular com o app aberto.
import { useEffect } from "react";
import { applyTheme, readThemePref } from "@/lib/hive/theme";

export function ThemeSync() {
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const onChange = () => {
      if (readThemePref() === "auto") applyTheme("auto");
    };
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  return null;
}
