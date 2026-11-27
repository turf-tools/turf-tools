import { useEffect, useState, type ReactNode } from "react";
import { Button } from "~/components/button";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "~/components/dialog";
import { Icon } from "~/components/icon";
import { Toggle } from "~/components/toggle";
import {
  EXCEL_MAX_ROWS,
  PEOPLE_DEFAULT,
  type ExportColumns,
  type ExportFormat,
  type ExportRows,
} from "~/lib/export-columns";

export type ExportChoice = { rows: ExportRows; format: ExportFormat; columns: string[] };

// The file is written in full before the download starts, so big ones pause.
const LARGE_EXPORT_ROWS = 100_000;

const CHIP = "aria-pressed:border-muted-foreground data-[state=on]:border-muted-foreground";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

// One toggle per option, exactly one pressed.
function Choice<T extends string>({
  options,
  value,
  onChange,
}: {
  options: ReadonlyArray<{ value: T; label: string; disabled?: boolean }>;
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div className="flex gap-1.5">
      {options.map((o) => (
        <Toggle
          key={o.value}
          size="sm"
          variant="outline"
          pressed={value === o.value}
          disabled={o.disabled}
          onPressedChange={() => onChange(o.value)}
          className={CHIP}
        >
          {o.label}
        </Toggle>
      ))}
    </div>
  );
}

type ColumnMode = "default" | "all" | "custom";

const DEFAULT_MODE: Record<ExportRows, ColumnMode> = { people: "default", households: "all" };
const NO_CUSTOM: Record<ExportRows, string[] | null> = { people: null, households: null };

export function ExportDialog({
  open,
  onOpenChange,
  columns,
  counts,
  onExport,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  columns: ExportColumns;
  // Rows each choice would export; null while the counts load.
  counts: Record<ExportRows, number> | null;
  onExport: (choice: ExportChoice) => void;
}) {
  const [rows, setRows] = useState<ExportRows>("people");
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [mode, setMode] = useState(DEFAULT_MODE);
  // Seeded from the columns showing when Custom is first picked; editing a
  // preset's chips replaces it with that preset plus the edit.
  const [custom, setCustom] = useState(NO_CUSTOM);
  const [shown, setShown] = useState(false);

  // Every open starts from the defaults.
  useEffect(() => {
    if (!open) return;
    setRows("people");
    setFormat("csv");
    setMode(DEFAULT_MODE);
    setCustom(NO_CUSTOM);
    setShown(false);
  }, [open]);

  const allKeys = columns[rows].map((c) => c.key);
  const presetKeys = (m: ColumnMode) =>
    m === "default" ? allKeys.filter((k) => PEOPLE_DEFAULT.includes(k)) : allKeys;
  // Catalog order, whatever order the chips were clicked in.
  const picked =
    mode[rows] === "custom"
      ? allKeys.filter((k) => (custom[rows] ?? []).includes(k))
      : presetKeys(mode[rows]);
  const modes: ReadonlyArray<{ value: ColumnMode; label: string }> = [
    ...(rows === "people" ? [{ value: "default" as const, label: "Default" }] : []),
    { value: "all", label: "All" },
    { value: "custom", label: "Custom" },
  ];

  const count = counts?.[rows] ?? null;
  const excelTooBig = count != null && count > EXCEL_MAX_ROWS;
  const canExport = picked.length > 0 && !(format === "excel" && excelTooBig);

  const pickMode = (next: ColumnMode) => {
    if (next === "custom") {
      if (custom[rows] == null) setCustom((c) => ({ ...c, [rows]: picked }));
      setShown(true);
    }
    setMode((m) => ({ ...m, [rows]: next }));
  };
  // Editing a preset's columns makes them the custom set.
  const toggleColumn = (key: string) => {
    setCustom((c) => ({
      ...c,
      [rows]: picked.includes(key) ? picked.filter((k) => k !== key) : [...picked, key],
    }));
    setMode((m) => ({ ...m, [rows]: "custom" }));
  };
  // Double-click keeps just that column; it lands after the click handlers.
  const selectOnly = (key: string) => {
    setCustom((c) => ({ ...c, [rows]: [key] }));
    setMode((m) => ({ ...m, [rows]: "custom" }));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Export segment</DialogTitle>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!canExport) return;
            onExport({ rows, format, columns: picked });
            onOpenChange(false);
          }}
          className="flex flex-col gap-4"
        >
          <div className="mt-3 flex flex-col gap-4 text-sm">
            <Field label="One row per">
              <Choice
                options={[
                  { value: "people", label: "Person" },
                  { value: "households", label: "Household" },
                ]}
                value={rows}
                onChange={setRows}
              />
              {/* A blank line holds the space while the counts load, so the
                  dialog doesn't grow when they arrive. */}
              <span className="text-muted-foreground italic">
                {counts == null
                  ? "\u00a0"
                  : rows === "people"
                    ? `Exporting ${counts.people.toLocaleString()} people.`
                    : `Exporting ${counts.households.toLocaleString()} households of ${counts.people.toLocaleString()} people.`}
                {count != null && count > LARGE_EXPORT_ROWS
                  ? " Large exports can take a moment to start."
                  : null}
              </span>
            </Field>
            <Field label="Format">
              <Choice
                options={[
                  { value: "csv", label: "CSV" },
                  { value: "parquet", label: "Parquet" },
                  { value: "excel", label: "Excel", disabled: excelTooBig },
                ]}
                value={format}
                onChange={setFormat}
              />
              {excelTooBig ? (
                <span className="text-muted-foreground italic">
                  Excel only supports {EXCEL_MAX_ROWS.toLocaleString()} rows.
                </span>
              ) : null}
            </Field>
            <Field label={`Columns (${picked.length})`}>
              <div className="flex flex-wrap items-center gap-1.5">
                <Choice options={modes} value={mode[rows]} onChange={pickMode} />
                <Toggle
                  size="sm"
                  variant="outline"
                  pressed={shown}
                  onPressedChange={setShown}
                  className={CHIP}
                >
                  <Icon name={shown ? "eye-off" : "eye"} />
                  {shown ? "Hide" : "Show"}
                </Toggle>
              </div>
              {shown ? (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {columns[rows].map((c) => (
                    <Toggle
                      key={c.key}
                      size="sm"
                      variant="outline"
                      pressed={picked.includes(c.key)}
                      onPressedChange={() => toggleColumn(c.key)}
                      onDoubleClick={() => selectOnly(c.key)}
                      className={CHIP}
                    >
                      {c.label}
                    </Toggle>
                  ))}
                </div>
              ) : null}
            </Field>
          </div>
          <div className="mt-2 flex justify-end gap-2">
            <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
            <Button type="submit" disabled={!canExport}>
              <Icon name="download" />
              Export
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
