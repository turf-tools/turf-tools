import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { useDeferredRadioDropdown } from "~/lib/use-deferred-radio-dropdown";
import { Button } from "./button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";

const ALL_VALUE = "__all__";

type FilterOption = {
  value: string;
  label: string;
};

interface FilterProps {
  icon?: ReactNode;
  // `null` renders as whitespace — for "still resolving" without flashing
  // a misleading default into the DOM.
  label: string | null;
  value: string | null;
  options: FilterOption[];
  // `null` removes the "All" row entirely — for contexts where a
  // selection is required (the mobile turf list).
  allLabel?: string | null;
  onChange: (next: string | null) => void;
}

export function Filter({ icon, label, value, options, allLabel = "All", onChange }: FilterProps) {
  const dd = useDeferredRadioDropdown({
    onCommit: (v) => onChange(v === ALL_VALUE ? null : v),
  });

  return (
    <DropdownMenu {...dd.menu}>
      <DropdownMenuTrigger render={<Button variant="outline" />}>
        {icon}
        <span>{label ?? " "}</span>
        <ChevronDown className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuRadioGroup {...dd.radio} value={value ?? ALL_VALUE}>
          {allLabel !== null ? (
            <DropdownMenuRadioItem value={ALL_VALUE}>{allLabel}</DropdownMenuRadioItem>
          ) : null}
          {options.map((o) => (
            <DropdownMenuRadioItem key={o.value} value={o.value}>
              {o.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
