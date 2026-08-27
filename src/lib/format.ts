/** Middle-truncate a mono value (address, hash, tx id) for display: `0x1234...ABCD`. Never
 * truncates a value shorter than `prefix + suffix + 3`, so short test/demo values render intact. */
export function truncateMiddle(value: string, prefix = 6, suffix = 4): string {
  if (value.length <= prefix + suffix + 3) return value;
  return `${value.slice(0, prefix)}...${value.slice(value.length - suffix)}`;
}

export function formatUnixSeconds(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function formatCountdown(secondsRemaining: number): string {
  const clamped = Math.max(0, Math.floor(secondsRemaining));
  const m = Math.floor(clamped / 60);
  const s = clamped % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
