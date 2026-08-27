const FILTERS = [
  "Failed to decrypt message with any known session",
  "Session error:",
  "Closing session:",
  "Bad MAC",
  "Invalid PreKey ID",
  "No session record",
];

export function installConsoleFilter(): void {
  const origError = console.error.bind(console);
  const origInfo = console.info.bind(console);

  console.error = (...args: unknown[]) => {
    const text = args.map((a) => String(a)).join(" ");
    if (FILTERS.some((f) => text.includes(f))) return;
    origError(...args);
  };
  console.info = (...args: unknown[]) => {
    const text = args.map((a) => String(a)).join(" ");
    if (FILTERS.some((f) => text.includes(f))) return;
    origInfo(...args);
  };
}
