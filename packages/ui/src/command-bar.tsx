"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "./primitives";

/**
 * 顶栏命令入口（⌘K）。不自动抢焦点，不打断打字（§8.3 #7）。
 */
export function CommandBar({
  onSubmit,
  placeholder = "说点什么…（⌘K）",
  right,
}: {
  onSubmit?: (text: string) => void;
  placeholder?: string;
  right?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(true);
      }
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const submit = () => {
    const text = value.trim();
    if (!text) return;
    onSubmit?.(text);
    setValue("");
    setOpen(false);
  };

  return (
    <div className="flex items-center gap-3">
      {open ? (
        <div className="flex min-w-[280px] items-center gap-2 rounded-md border border-indigo-600/40 bg-surface px-3 py-1.5">
          <span className="text-xs text-ink-400">⌘K</span>
          <input
            ref={inputRef}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
            placeholder={placeholder}
            className="min-h-8 w-full bg-transparent text-sm text-ink-900 outline-none placeholder:text-ink-400"
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={cn(
            "min-h-9 rounded-md border border-line bg-surface px-3 text-sm text-ink-400",
            "hover:border-ink-400 hover:text-ink-700",
          )}
        >
          {placeholder}
        </button>
      )}
      {right}
    </div>
  );
}
