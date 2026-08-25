import { Icon } from "~/components/icon";
import { useQuery } from "@tanstack/react-query";
import { Fragment, type ReactNode, useEffect, useMemo, useState } from "react";
import { Button } from "~/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/dropdown-menu";
import { Calendar } from "~/components/calendar";
import { Input } from "~/components/input";
import { NumberInput } from "~/components/number-input";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/popover";
import { Toggle } from "~/components/toggle";
import {
  type AddressFilter,
  type AgeRangeFilter,
  type CanvassResponseFilter,
  type CanvassOutcomeFilter,
  type Criteria,
  type DateRangeFilter,
  type EnumFilter,
  type Filter,
  type FilterDef,
  type NumberRangeFilter,
  type SegmentFilter,
  type TextFilter,
  type TextMultiFilter,
  type Verb,
  VERB_META,
  type VotingHistoryCountFilter,
  type VotingHistoryDetailFilter,
} from "~/lib/filters";
import { electionsQuery } from "~/lib/queries/elections";
import { questionsWithOptionsQuery } from "~/lib/queries/questions";
import { findCyclicSegmentIds, type SegmentLike } from "~/lib/segment-refs";
import { cn } from "~/lib/utils";

// Value editors for every filter-leaf kind, shared by the segment editor
// and the Results condition chips. Each is a controlled component over
// one leaf; `FilterValueEditor` dispatches by kind.
export function FilterValueEditor({
  filter,
  def,
  onChange,
  currentSegmentId,
  allSegments,
}: {
  filter: Filter;
  def: FilterDef | undefined;
  onChange: (next: Filter) => void;
  // Cycle exclusion for segment refs; pass "" outside the segment editor.
  currentSegmentId: string;
  allSegments: ReadonlyArray<{
    segmentId: string;
    name: string;
    criteria: unknown;
    isArchived: boolean;
  }>;
}) {
  return (
    <>
      {filter.kind === "enum" && def?.kind === "enum" ? (
        <EnumFilterEditor filter={filter} def={def} onChange={onChange} />
      ) : null}
      {filter.kind === "age-range" && def?.kind === "age-range" ? (
        <AgeRangeFilterEditor filter={filter} onChange={onChange} />
      ) : null}
      {filter.kind === "text" && def?.kind === "text" ? (
        <TextFilterEditor filter={filter} onChange={onChange} />
      ) : null}
      {filter.kind === "text-multi" && def?.kind === "text-multi" ? (
        <TextMultiFilterEditor filter={filter} onChange={onChange} />
      ) : null}
      {filter.kind === "date-range" && def?.kind === "date-range" ? (
        <DateRangeFilterEditor filter={filter} onChange={onChange} />
      ) : null}
      {filter.kind === "voting-history-count" && def?.kind === "voting-history-count" ? (
        <VotingHistoryCountEditor filter={filter} onChange={onChange} />
      ) : null}
      {filter.kind === "voting-history-detail" && def?.kind === "voting-history-detail" ? (
        <VotingHistoryDetailEditor filter={filter} onChange={onChange} />
      ) : null}
      {filter.kind === "address" && def?.kind === "address" ? (
        <AddressFilterEditor filter={filter} onChange={onChange} />
      ) : null}
      {filter.kind === "number-range" && def?.kind === "number-range" ? (
        <NumberRangeFilterEditor filter={filter} onChange={onChange} />
      ) : null}
      {filter.kind === "canvass-outcome" && def?.kind === "canvass-outcome" ? (
        <CanvassOutcomeEditor filter={filter} def={def} onChange={onChange} />
      ) : null}
      {filter.kind === "canvass-response" && def?.kind === "canvass-response" ? (
        <CanvassResponseEditor filter={filter} onChange={onChange} />
      ) : null}
      {filter.kind === "segment" && def?.kind === "segment" ? (
        <SegmentFilterEditor
          filter={filter}
          onChange={onChange}
          currentSegmentId={currentSegmentId}
          allSegments={allSegments}
        />
      ) : null}
    </>
  );
}

function TextFilterEditor({
  filter,
  onChange,
}: {
  filter: TextFilter;
  onChange: (next: Filter) => void;
}) {
  // Local input state so typing doesn't fire onChange per keystroke
  // (which would refetch on every character). Committed value lives in
  // the segment cache; sync down on prop change, commit up on blur/Enter.
  const [local, setLocal] = useState(filter.value);
  useEffect(() => setLocal(filter.value), [filter.value]);
  const commit = () => {
    if (local !== filter.value) onChange({ ...filter, value: local });
  };
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">Contains</span>
      <Input
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
        className="h-8 text-sm"
        placeholder="any substring"
      />
    </div>
  );
}

// Per-key normalizer for text-multi values. Run on each token at commit
// time so the canonical form is what gets stored and queried. Anything
// the normalizer doesn't recognize passes through unchanged so the user
// can see the bad value and correct it.
const NORMALIZERS: Record<string, (v: string) => string> = {
  // NYC precincts canonicalize as `AA-EEE` (zero-padded AD, dash, zero-padded ED).
  // Accept compact 5-digit input as a shortcut.
  precinct: (v) => (/^\d{5}$/.test(v) ? `${v.slice(0, 2)}-${v.slice(2)}` : v),
};

function TextMultiFilterEditor({
  filter,
  onChange,
}: {
  filter: TextMultiFilter;
  onChange: (next: Filter) => void;
}) {
  // Local input state — same commit-on-blur/Enter pattern as TextFilterEditor.
  // Parse on commit: split on comma, trim, normalize, drop empties, dedupe
  // (preserve order).
  const [local, setLocal] = useState(filter.values.join(", "));
  useEffect(() => setLocal(filter.values.join(", ")), [filter.values]);
  const normalize = NORMALIZERS[filter.key] ?? ((v: string) => v);
  const commit = () => {
    const tokens = local
      .split(",")
      .map((t) => normalize(t.trim()))
      .filter((t) => t.length > 0);
    const next = Array.from(new Set(tokens));
    const same =
      next.length === filter.values.length && next.every((v, i) => v === filter.values[i]);
    if (!same) onChange({ ...filter, values: next });
    else setLocal(next.join(", "));
  };
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">Equals</span>
      <Input
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
        className="h-8 text-sm"
        placeholder="single or comma-separated"
      />
    </div>
  );
}

function EnumFilterEditor({
  filter,
  def,
  onChange,
}: {
  filter: EnumFilter;
  def: Extract<FilterDef, { kind: "enum" }>;
  onChange: (next: Filter) => void;
}) {
  const toggle = (value: string) => {
    const next = filter.values.includes(value)
      ? filter.values.filter((v) => v !== value)
      : [...filter.values, value];
    onChange({ ...filter, values: next });
  };
  // Render selected values even when the option set no longer carries them
  // (custom-field re-derives and manifest drift across versions both retire
  // values) — a stale selection stays visible and untogglable-away instead of
  // silently constraining the query. Once untoggled, it disappears for good.
  const options: Array<{ value: string; label?: string }> = [
    ...def.values,
    ...filter.values
      .filter((v) => !def.values.some((o) => o.value === v))
      .map((v) => ({ value: v })),
  ];
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((v) => (
        <Toggle
          key={v.value}
          size="sm"
          variant="outline"
          pressed={filter.values.includes(v.value)}
          onPressedChange={() => toggle(v.value)}
          className="aria-pressed:border-muted-foreground data-[state=on]:border-muted-foreground"
        >
          {v.label ?? v.value}
        </Toggle>
      ))}
    </div>
  );
}

function CanvassOutcomeEditor({
  filter,
  def,
  onChange,
}: {
  filter: CanvassOutcomeFilter;
  def: Extract<FilterDef, { kind: "canvass-outcome" }>;
  onChange: (next: Filter) => void;
}) {
  const toggle = (value: string) => {
    const next = filter.outcomes.includes(value)
      ? filter.outcomes.filter((v) => v !== value)
      : [...filter.outcomes, value];
    onChange({ ...filter, outcomes: next });
  };
  return (
    <div className="flex flex-wrap gap-1.5">
      {def.values.map((v) => (
        <Toggle
          key={v.value}
          size="sm"
          variant="outline"
          pressed={filter.outcomes.includes(v.value)}
          onPressedChange={() => toggle(v.value)}
          className="aria-pressed:border-muted-foreground data-[state=on]:border-muted-foreground"
        >
          {v.label ?? v.value}
        </Toggle>
      ))}
    </div>
  );
}

function CanvassResponseEditor({
  filter,
  onChange,
}: {
  filter: CanvassResponseFilter;
  onChange: (next: Filter) => void;
}) {
  // Names + options in one query, so the dropdown and toggles render off the
  // same data (no per-question fetch).
  const { data: questions } = useQuery(questionsWithOptionsQuery());

  // Mirror the selection locally so the options swap in the same frame the
  // dropdown closes, not a tick later when the criteria write notifies.
  const [localQuestionId, setLocalQuestionId] = useState(filter.questionId);
  useEffect(() => setLocalQuestionId(filter.questionId), [filter.questionId]);
  const [showArchived, setShowArchived] = useState(false);
  const [showArchivedQuestions, setShowArchivedQuestions] = useState(false);

  const selected = questions?.find((q) => q.questionId === localQuestionId);
  const triggerLabel = selected
    ? selected.archived
      ? `${selected.name} (archived)`
      : selected.name
    : localQuestionId && questions
      ? "(deleted)"
      : "Select question…";
  // Open-ended questions have no options to filter on — offer only select
  // types (keep a referenced one visible so a saved filter stays editable).
  const filterable =
    questions?.filter((q) => q.responseType !== "open_ended" || q.questionId === localQuestionId) ??
    [];
  const activeQuestions = filterable.filter((q) => !q.archived);
  const archivedQuestions = filterable.filter((q) => q.archived);
  // Keep the selected question in the menu even if it's archived (so a saved
  // filter's question doesn't vanish on load); "Show archived" reveals the rest.
  const visibleArchivedQuestions = showArchivedQuestions
    ? archivedQuestions
    : archivedQuestions.filter((q) => q.questionId === localQuestionId);
  const archivedQuestionsHidden = archivedQuestions.some((q) => q.questionId !== localQuestionId);
  const options = selected?.options ?? [];
  // Show active options; keep a referenced archived option visible (so it can
  // be removed), and reveal the rest when "Show archived" is on.
  const visibleOptions = options.filter(
    (o) => showArchived || !o.archived || filter.optionIds.includes(o.responseOptionId),
  );
  // Only offer the toggle when there's a hidden archived option to reveal.
  const archivedHidden = options.some(
    (o) => o.archived && !filter.optionIds.includes(o.responseOptionId),
  );

  const toggle = (optionId: string) => {
    const next = filter.optionIds.includes(optionId)
      ? filter.optionIds.filter((v) => v !== optionId)
      : [...filter.optionIds, optionId];
    onChange({ ...filter, optionIds: next });
  };

  // Switching questions clears the now-irrelevant option set.
  const selectQuestion = (questionId: string) => {
    setLocalQuestionId(questionId);
    setShowArchived(false);
    onChange({ ...filter, questionId, optionIds: [] });
  };

  return (
    <div className="flex flex-col gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="outline" className="w-full justify-between font-normal" />}
        >
          <span className={cn("truncate", !selected ? "text-muted-foreground" : null)}>
            {triggerLabel}
          </span>
          <Icon name="chevron-down" className="text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="min-w-48 max-h-[291px] overflow-y-auto">
          {!questions ? null : questions.length === 0 ? (
            <DropdownMenuItem disabled>No questions available</DropdownMenuItem>
          ) : (
            <>
              {activeQuestions.map((q) => (
                <DropdownMenuItem key={q.questionId} onClick={() => selectQuestion(q.questionId)}>
                  {q.name}
                </DropdownMenuItem>
              ))}
              {visibleArchivedQuestions.map((q) => (
                <DropdownMenuItem key={q.questionId} onClick={() => selectQuestion(q.questionId)}>
                  {q.name}
                  {" (archived)"}
                </DropdownMenuItem>
              ))}
              {archivedQuestionsHidden ? (
                <DropdownMenuItem
                  className="text-muted-foreground"
                  closeOnClick={false}
                  onClick={() => setShowArchivedQuestions((v) => !v)}
                >
                  {showArchivedQuestions ? "Hide archived" : "Show archived"}
                </DropdownMenuItem>
              ) : null}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {localQuestionId && (visibleOptions.length > 0 || archivedHidden) ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {visibleOptions.map((o) => (
            <Toggle
              key={o.responseOptionId}
              size="sm"
              variant="outline"
              pressed={filter.optionIds.includes(o.responseOptionId)}
              onPressedChange={() => toggle(o.responseOptionId)}
              className="aria-pressed:border-muted-foreground data-[state=on]:border-muted-foreground"
            >
              {o.text.trim() ? (
                o.text
              ) : (
                <span className="italic text-muted-foreground">Empty option</span>
              )}
              {o.archived ? " (archived)" : null}
            </Toggle>
          ))}
          {archivedHidden ? (
            <Button
              variant="outline"
              size="sm"
              className="text-[0.8rem] text-muted-foreground"
              onClick={() => setShowArchived((v) => !v)}
            >
              {showArchived ? "Hide archived" : "Show archived"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function AgeRangeFilterEditor({
  filter,
  onChange,
}: {
  filter: AgeRangeFilter;
  onChange: (next: Filter) => void;
}) {
  // Same commit-on-blur/Enter pattern as text.
  const [localMin, setLocalMin] = useState(filter.min == null ? "" : String(filter.min));
  const [localMax, setLocalMax] = useState(filter.max == null ? "" : String(filter.max));
  useEffect(() => setLocalMin(filter.min == null ? "" : String(filter.min)), [filter.min]);
  useEffect(() => setLocalMax(filter.max == null ? "" : String(filter.max)), [filter.max]);
  const commit = () => {
    const min = localMin === "" ? null : Number(localMin);
    const max = localMax === "" ? null : Number(localMax);
    if (min !== filter.min || max !== filter.max) onChange({ ...filter, min, max });
  };
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">Between</span>
      <NumberInput
        value={localMin}
        onChange={setLocalMin}
        onCommit={commit}
        min={0}
        max={120}
        className="h-7 w-16 px-2"
        placeholder="min"
      />
      <span className="text-muted-foreground">and</span>
      <NumberInput
        value={localMax}
        onChange={setLocalMax}
        onCommit={commit}
        min={0}
        max={120}
        className="h-7 w-16 px-2"
        placeholder="max"
      />
      <span className="text-muted-foreground">years</span>
    </div>
  );
}

// ISO 8601 YYYY-MM-DD ↔ Date helpers. Treat the string as a *local* date —
// date-only values are inherently timezone-naïve. Round-trip stays consistent
// with what react-day-picker shows the user.
function isoToDate(s: string | null): Date | undefined {
  if (!s) return undefined;
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return undefined;
  return new Date(y, m - 1, d);
}
function dateToIso(d: Date | undefined): string | null {
  if (!d) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function formatHuman(s: string | null): string {
  const d = isoToDate(s);
  if (!d) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function DatePickerInput({
  value,
  onChange,
  placeholder,
}: {
  value: string | null;
  onChange: (next: string | null) => void;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex items-center gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button variant="outline" size="sm" className="h-7 px-2 font-normal">
              <Icon name="calendar" className="size-3.5" />
              <span className={cn(!value && "text-muted-foreground")}>
                {value ? formatHuman(value) : placeholder}
              </span>
            </Button>
          }
        />
        <PopoverContent
          align="start"
          className="w-auto p-0"
          // Skip the fade/zoom animation so the close doesn't visually
          // overlap the map refetch that follows a date selection.
          style={{ animationDuration: "0s", transitionDuration: "0s" }}
        >
          <Calendar
            mode="single"
            selected={isoToDate(value)}
            onSelect={(d) => {
              onChange(dateToIso(d));
              setOpen(false);
            }}
            captionLayout="dropdown"
          />
        </PopoverContent>
      </Popover>
      {value ? (
        <Button
          variant="outline"
          size="icon-sm"
          onClick={() => onChange(null)}
          aria-label="Clear date"
        >
          <Icon name="x" className="size-4" />
        </Button>
      ) : null}
    </div>
  );
}

function AddressFilterEditor({
  filter,
  onChange,
}: {
  filter: AddressFilter;
  onChange: (next: Filter) => void;
}) {
  // Commit-on-blur for each sub-field — same pattern as TextFilterEditor.
  // All fields optional; each non-empty one ANDs into the WHERE clause.
  type SubKey = "line1" | "city" | "state" | "zip";
  const subField = (key: SubKey, placeholder: string, width: string) => (
    <SubTextInput
      value={filter[key]}
      placeholder={placeholder}
      className={cn("h-7 px-2", width)}
      onCommit={(v) => {
        if (v !== filter[key]) onChange({ ...filter, [key]: v });
      }}
    />
  );
  return (
    <div className="flex flex-col gap-2 text-sm">
      {subField("line1", "street", "w-full")}
      <div className="flex items-center gap-2">
        {subField("city", "city", "flex-1")}
        {subField("state", "state", "w-14")}
        {subField("zip", "zip", "w-20")}
      </div>
    </div>
  );
}

// Small local helper — text input with commit-on-blur/Enter.
function SubTextInput({
  value,
  placeholder,
  className,
  onCommit,
}: {
  value: string;
  placeholder: string;
  className?: string;
  onCommit: (next: string) => void;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  const commit = () => onCommit(local);
  return (
    <Input
      value={local}
      placeholder={placeholder}
      className={className}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
      }}
    />
  );
}

function DateRangeFilterEditor({
  filter,
  onChange,
}: {
  filter: DateRangeFilter;
  onChange: (next: Filter) => void;
}) {
  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">Between</span>
        <DatePickerInput
          value={filter.min}
          onChange={(min) => onChange({ ...filter, min })}
          placeholder="any date"
        />
      </div>
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">and</span>
        <DatePickerInput
          value={filter.max}
          onChange={(max) => onChange({ ...filter, max })}
          placeholder="any date"
        />
      </div>
    </div>
  );
}

function VotingHistoryCountEditor({
  filter,
  onChange,
}: {
  filter: VotingHistoryCountFilter;
  onChange: (next: Filter) => void;
}) {
  const [localCount, setLocalCount] = useState(String(filter.count));
  const [localWindow, setLocalWindow] = useState(String(filter.windowYears));
  useEffect(() => setLocalCount(String(filter.count)), [filter.count]);
  useEffect(() => setLocalWindow(String(filter.windowYears)), [filter.windowYears]);
  const commitCount = () => {
    const n = Number(localCount);
    if (Number.isFinite(n) && n !== filter.count) onChange({ ...filter, count: n });
  };
  const commitWindow = () => {
    const n = Number(localWindow);
    if (Number.isFinite(n) && n !== filter.windowYears) onChange({ ...filter, windowYears: n });
  };
  // Radio-style toggles: clicking an already-pressed item is a no-op (we
  // never want zero selected). Mirrors EnumFilterEditor styling so these
  // read as the same kind of choice control.
  const radioClass = "aria-pressed:border-muted-foreground data-[state=on]:border-muted-foreground";
  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="flex items-center gap-1.5">
        <span className="text-muted-foreground">Voted in</span>
        <Toggle
          size="sm"
          variant="outline"
          pressed={filter.comparator === "at_least"}
          onPressedChange={(p) => p && onChange({ ...filter, comparator: "at_least" })}
          className={radioClass}
        >
          At least
        </Toggle>
        <Toggle
          size="sm"
          variant="outline"
          pressed={filter.comparator === "exactly"}
          onPressedChange={(p) => p && onChange({ ...filter, comparator: "exactly" })}
          className={radioClass}
        >
          Exactly
        </Toggle>
        <NumberInput
          value={localCount}
          onChange={setLocalCount}
          onCommit={commitCount}
          min={0}
          className="h-7 w-12 px-2"
        />
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-muted-foreground">of</span>
        <Toggle
          size="sm"
          variant="outline"
          pressed={filter.type === "primary"}
          onPressedChange={(p) => p && onChange({ ...filter, type: "primary" })}
          className={radioClass}
        >
          Primaries
        </Toggle>
        <Toggle
          size="sm"
          variant="outline"
          pressed={filter.type === "general"}
          onPressedChange={(p) => p && onChange({ ...filter, type: "general" })}
          className={radioClass}
        >
          Generals
        </Toggle>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-muted-foreground">in last</span>
        <NumberInput
          value={localWindow}
          onChange={setLocalWindow}
          onCommit={commitWindow}
          min={1}
          className="h-7 w-12 px-2"
        />
        <span className="text-muted-foreground">years</span>
      </div>
    </div>
  );
}

function NumberRangeFilterEditor({
  filter,
  onChange,
}: {
  filter: NumberRangeFilter;
  onChange: (next: Filter) => void;
}) {
  // Same commit-on-blur/Enter pattern as text. Plain Inputs (not NumberInput,
  // which is digit-only) — scores are often decimals.
  const [localMin, setLocalMin] = useState(filter.min == null ? "" : String(filter.min));
  const [localMax, setLocalMax] = useState(filter.max == null ? "" : String(filter.max));
  useEffect(() => setLocalMin(filter.min == null ? "" : String(filter.min)), [filter.min]);
  useEffect(() => setLocalMax(filter.max == null ? "" : String(filter.max)), [filter.max]);
  const parse = (v: string) => {
    if (v.trim() === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const commit = () => {
    const min = parse(localMin);
    const max = parse(localMax);
    if (min !== filter.min || max !== filter.max) onChange({ ...filter, min, max });
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    }
  };
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">Between</span>
      <Input
        value={localMin}
        onChange={(e) => setLocalMin(e.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
        className="h-7 w-20 px-2"
        placeholder="min"
      />
      <span className="text-muted-foreground">and</span>
      <Input
        value={localMax}
        onChange={(e) => setLocalMax(e.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
        className="h-7 w-20 px-2"
        placeholder="max"
      />
    </div>
  );
}

function VotingHistoryDetailEditor({
  filter,
  onChange,
}: {
  filter: VotingHistoryDetailFilter;
  onChange: (next: Filter) => void;
}) {
  // Elections are precomputed per active dataset (immutable, cached hard). Gate
  // on data so first load doesn't flash the empty state; the global spinner
  // covers the wait.
  const { data } = useQuery(electionsQuery());
  const toggle = (value: string) => {
    const next = filter.elections.includes(value)
      ? filter.elections.filter((v) => v !== value)
      : [...filter.elections, value];
    onChange({ ...filter, elections: next });
  };
  const radioClass = "aria-pressed:border-muted-foreground data-[state=on]:border-muted-foreground";
  if (!data) return null;
  if (data.elections.length === 0) {
    return <p className="text-sm text-muted-foreground">No elections in this dataset.</p>;
  }
  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="flex items-center gap-1.5">
        <span className="text-muted-foreground">Voted in</span>
        <Toggle
          size="sm"
          variant="outline"
          pressed={filter.mode === "any"}
          onPressedChange={(p) => p && onChange({ ...filter, mode: "any" })}
          className={radioClass}
        >
          Any
        </Toggle>
        <Toggle
          size="sm"
          variant="outline"
          pressed={filter.mode === "all"}
          onPressedChange={(p) => p && onChange({ ...filter, mode: "all" })}
          className={radioClass}
        >
          All
        </Toggle>
        <span className="text-muted-foreground">of:</span>
      </div>
      <div className="flex max-h-56 flex-col gap-1.5 overflow-y-auto">
        {data.elections.map((e) => (
          <Toggle
            key={e.value}
            size="sm"
            variant="outline"
            pressed={filter.elections.includes(e.value)}
            onPressedChange={() => toggle(e.value)}
            className={cn("h-7 w-full shrink-0 justify-start", radioClass)}
          >
            {e.label}
          </Toggle>
        ))}
      </div>
    </div>
  );
}

function SegmentFilterEditor({
  filter,
  onChange,
  currentSegmentId,
  allSegments,
}: {
  filter: SegmentFilter;
  onChange: (next: Filter) => void;
  currentSegmentId: string;
  allSegments: ReadonlyArray<{
    segmentId: string;
    name: string;
    criteria: unknown;
    isArchived: boolean;
  }>;
}) {
  // Segments that would form a cycle if selected — current segment plus
  // any that transitively reference it. The set is content-dependent;
  // re-derive whenever the segments list changes.
  const cyclic = useMemo<Set<string>>(() => {
    const entries: Array<[string, SegmentLike]> = allSegments.map((s) => [
      s.segmentId,
      { segmentId: s.segmentId, name: s.name, criteria: s.criteria as Criteria },
    ]);
    return findCyclicSegmentIds(currentSegmentId, new globalThis.Map(entries));
  }, [allSegments, currentSegmentId]);

  const selectable = [...allSegments]
    // Archived segments can't be newly referenced, but an existing
    // reference to one keeps resolving (the `selected` lookup below
    // reads the unfiltered list).
    .filter((s) => !cyclic.has(s.segmentId) && !s.isArchived)
    .sort((a, b) => a.name.localeCompare(b.name));
  const selected = filter.segmentId
    ? allSegments.find((s) => s.segmentId === filter.segmentId)
    : null;
  const triggerLabel = selected
    ? selected.name
    : filter.segmentId
      ? "(deleted)"
      : "Select segment…";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" className="w-full justify-between font-normal" />}
      >
        <span className={cn("truncate", !selected ? "text-muted-foreground" : null)}>
          {triggerLabel}
        </span>
        <Icon name="chevron-down" className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="min-w-48 max-h-[291px] overflow-y-auto">
        {selectable.length === 0 ? (
          <DropdownMenuItem disabled>No other segments available</DropdownMenuItem>
        ) : (
          selectable.map((s) => (
            <DropdownMenuItem
              key={s.segmentId}
              onClick={() => onChange({ ...filter, segmentId: s.segmentId })}
            >
              {s.name}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AddStepMenu({
  sections,
  isFirstStep,
  onAdd,
}: {
  sections: ReadonlyArray<ReadonlyArray<FilterDef>>;
  isFirstStep: boolean;
  onAdd: (verb: Verb, def: FilterDef) => void;
}) {
  const verbIcons: Record<Verb, ReactNode> = {
    narrow: <Icon name="funnel" className="size-3" strokeWidth={2.5} />,
    add: <Icon name="plus" className="size-3" strokeWidth={2.5} />,
    remove: <Icon name="minus" className="size-3" strokeWidth={2.5} />,
  };

  const allVerbs: Verb[] = ["narrow", "remove", "add"];

  return (
    <div className="flex gap-2">
      {allVerbs.map((verb) => {
        const { label } = VERB_META[verb];
        const disabled = isFirstStep && verb === "add"; // add only makes sense after a first step
        const visibleSections = sections;
        return (
          <div key={verb} className="flex-1">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    disabled={disabled}
                    className="w-full gap-1.5 text-sm"
                  />
                }
              >
                {verbIcons[verb]}
                {label}
              </DropdownMenuTrigger>
              <DropdownMenuContent align={verb === "add" ? "end" : "start"} className="min-w-48">
                {visibleSections.map((section, sectionIdx) => (
                  <Fragment key={sectionIdx}>
                    {sectionIdx > 0 ? <DropdownMenuSeparator /> : null}
                    {section.map((def) => (
                      <DropdownMenuItem key={def.key} onClick={() => onAdd(verb, def)}>
                        {def.kind === "segment" ? "Other Segment" : def.label}
                      </DropdownMenuItem>
                    ))}
                  </Fragment>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      })}
    </div>
  );
}
