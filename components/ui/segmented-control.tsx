import { cn } from "@/lib/utils";

export interface SegmentedControlProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
  className?: string;
}

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  className,
}: SegmentedControlProps<T>) {
  return (
    <div className={cn("inline-flex rounded-md bg-ink-50 p-0.5", className)}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={cn(
            "rounded px-3 py-1.5 text-sm font-medium transition-colors",
            value === opt.value ? "bg-surface text-ink-800 shadow-sm" : "text-ink-500 hover:text-ink-700"
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
