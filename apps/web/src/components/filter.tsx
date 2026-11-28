import { Icon } from "~/components/icon";
import { Fragment, type ReactNode } from "react";
import { useDeferredRadioDropdown } from "~/lib/use-deferred-radio-dropdown";
import { Button } from "./button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./dropdown-menu";

const ALL_VALUE = "__all__";

type FilterOption = {
  value: string;
  label: string;
  // Trailing marker (e.g. an archived badge); the label stays clean.
  icon?: ReactNode;
  // Consecutive options sharing a group render under one heading.
  group?: string;
};

interface FilterProps {
  icon?: ReactNode;
  // `null` renders as whitespace — for "still resolving" without flashing
  // a misleading default into the DOM.
  label: string | null;
  value: string | null;
  options: FilterOption[];
  // `null` drops the "All" row — for filters that must always have a
  // concrete selection.
  allLabel?: string | null;
  onChange: (next: string | null) => void;
  menuClassName?: string;
}

export function Filter({
  icon,
  label,
  value,
  options,
  allLabel = "All",
  onChange,
  menuClassName = "w-56",
}: FilterProps) {
  const dd = useDeferredRadioDropdown({
    onCommit: (v) => onChange(v === ALL_VALUE ? null : v),
  });

  return (
    <DropdownMenu {...dd.menu}>
      <DropdownMenuTrigger
        render={<Button variant="outline" className="max-w-56 min-w-0 shrink" />}
      >
        {icon}
        <span className="truncate">{label ?? " "}</span>
        <Icon name="chevron-down" className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={menuClassName}>
        <DropdownMenuRadioGroup {...dd.radio} value={value ?? ALL_VALUE}>
          {allLabel !== null ? (
            <DropdownMenuRadioItem value={ALL_VALUE}>{allLabel}</DropdownMenuRadioItem>
          ) : null}
          {groupRuns(options).map((run, i) => {
            const items = run.options.map((o) => (
              <DropdownMenuRadioItem key={o.value} value={o.value}>
                <span className="truncate">{o.label}</span>
                {o.icon}
              </DropdownMenuRadioItem>
            ));
            if (run.group === undefined) return <Fragment key={i}>{items}</Fragment>;
            // GroupLabel needs a Menu.Group; the radio group doesn't provide one.
            return (
              <Fragment key={i}>
                {i > 0 || allLabel !== null ? <DropdownMenuSeparator /> : null}
                <DropdownMenuGroup>
                  <DropdownMenuLabel className="truncate">{run.group}</DropdownMenuLabel>
                  {items}
                </DropdownMenuGroup>
              </Fragment>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Split options into runs of consecutive same-group entries, order kept.
function groupRuns(options: FilterOption[]) {
  const runs: { group: string | undefined; options: FilterOption[] }[] = [];
  for (const o of options) {
    const last = runs.at(-1);
    if (last && last.group === o.group) last.options.push(o);
    else runs.push({ group: o.group, options: [o] });
  }
  return runs;
}
