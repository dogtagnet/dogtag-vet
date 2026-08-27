"use client";

import {useRouter, useSearchParams, usePathname} from "next/navigation";
import {useEffect, useRef, useState} from "react";
import {Input} from "@/components/ui/controls";

/** Debounced `?q=` search box that drives a server component list page via the URL - list pages
 * stay server-rendered (no client-side data fetching/caching to reinvent) and the search term
 * survives a refresh or a shared link. */
export function SearchBox({placeholder}: {placeholder: string}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [value, setValue] = useState(searchParams.get("q") ?? "");
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    return () => clearTimeout(timeoutRef.current);
  }, []);

  function handleChange(next: string) {
    setValue(next);
    clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      const params = new URLSearchParams(searchParams);
      if (next) params.set("q", next);
      else params.delete("q");
      router.replace(`${pathname}?${params.toString()}`);
    }, 300);
  }

  return (
    <Input
      value={value}
      onChange={(e) => handleChange(e.target.value)}
      placeholder={placeholder}
      className="max-w-sm"
      aria-label={placeholder}
    />
  );
}
