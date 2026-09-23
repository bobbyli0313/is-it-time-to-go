"use client";

import { LOCALES, type Locale, type Translator } from "@/lib/i18n";

const LABELS: Record<Locale, string> = {
  en: "EN",
  zh: "中文",
};

/**
 * Locale switch. Changing it rewrites the `lang` query parameter, which is what
 * makes a scored trip shareable in the recipient's own language.
 */
export function LanguageSwitcher({
  locale,
  onChange,
  t,
}: {
  locale: Locale;
  onChange: (locale: Locale) => void;
  t: Translator;
}) {
  return (
    <div
      className="flex items-center gap-1 rounded-lg bg-white/5 p-1 ring-1 ring-white/10"
      role="group"
      aria-label={t("footer.language")}
    >
      {LOCALES.map((code) => {
        const active = code === locale;
        return (
          <button
            key={code}
            type="button"
            onClick={() => onChange(code)}
            aria-pressed={active}
            lang={code === "zh" ? "zh-CN" : "en"}
            className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
              active
                ? "bg-white/15 text-white shadow-sm"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            {LABELS[code]}
          </button>
        );
      })}
    </div>
  );
}
