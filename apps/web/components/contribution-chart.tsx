"use client";

import { formatTokens } from "@paco/shared";
import { useMemo } from "react";
import type { DateRange } from "@/lib/usage/types";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface DayData {
  date: string;
  inputTokens: number;
  outputTokens: number;
  messageCount: number;
  toolCallCount: number;
}

interface ContributionChartProps {
  data: DayData[];
  selectedRange?: DateRange;
  onSelectRange?: (range: DateRange | undefined) => void;
}

const DAYS_IN_WEEK = 7;
const WEEKS = 39;

function getIntensity(
  value: number,
  thresholds: [number, number, number, number],
): number {
  if (value === 0) return 0;
  if (value <= thresholds[0]) return 1;
  if (value <= thresholds[1]) return 2;
  if (value <= thresholds[2]) return 3;
  return 4;
}

function computeThresholds(values: number[]): [number, number, number, number] {
  const nonZero = values.filter((v) => v > 0).toSorted((a, b) => a - b);
  if (nonZero.length === 0) return [1, 2, 3, 4];

  const p25 = nonZero[Math.floor(nonZero.length * 0.25)] ?? 1;
  const p50 = nonZero[Math.floor(nonZero.length * 0.5)] ?? 2;
  const p75 = nonZero[Math.floor(nonZero.length * 0.75)] ?? 3;
  const max = nonZero[nonZero.length - 1] ?? 4;

  return [p25, p50, p75, max];
}

/*
 * Activity ramp, expressed as opacity over the theme's content colour.
 *
 * Not a fixed data-visualisation palette: this encodes "more of the same
 * thing", so it should read as one hue getting stronger and should follow the
 * theme. The previous pairs hard-coded a light ramp and a dark one, which had
 * to be kept in step by hand and inverted at the top end.
 */
const INTENSITY_CLASSES = [
  "bg-base-300",
  "bg-base-content/20",
  "bg-base-content/40",
  "bg-base-content/60",
  "bg-base-content/85",
];

function parseDateKey(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00`);
}

function formatDate(dateStr: string) {
  return parseDateKey(dateStr).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const CELL_SIZE = 11;
const CELL_GAP = 3;
const LEGEND_CELL_SIZE = 12;

export function ContributionChart({
  data,
  selectedRange,
  onSelectRange,
}: ContributionChartProps) {
  const { grid, selectedBounds, thresholds } = useMemo(() => {
    const dataMap = new Map<string, DayData>();
    for (const d of data) {
      dataMap.set(d.date, d);
    }

    const today = new Date();
    const todayStr = formatDateKey(today);

    const endDate = new Date(today);
    endDate.setDate(endDate.getDate() + (6 - endDate.getDay()));
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - WEEKS * DAYS_IN_WEEK + 1);

    const cells: Array<{
      date: string;
      data: DayData | undefined;
      isFuture: boolean;
    }> = [];

    const current = new Date(startDate);
    while (current <= endDate) {
      const key = formatDateKey(current);
      cells.push({
        date: key,
        data: dataMap.get(key),
        isFuture: key > todayStr,
      });
      current.setDate(current.getDate() + 1);
    }

    const values = cells
      .map((c) => c.data?.messageCount ?? 0)
      .filter((v) => v > 0);
    const t = computeThresholds(values);

    const weeks: (typeof cells)[] = [];
    for (let i = 0; i < cells.length; i += DAYS_IN_WEEK) {
      weeks.push(cells.slice(i, i + DAYS_IN_WEEK));
    }

    const rangeFrom = selectedRange?.from
      ? formatDateKey(selectedRange.from)
      : null;
    const rangeTo = selectedRange?.to
      ? formatDateKey(selectedRange.to)
      : rangeFrom;
    const bounds =
      rangeFrom && rangeTo
        ? rangeFrom <= rangeTo
          ? { from: rangeFrom, to: rangeTo }
          : { from: rangeTo, to: rangeFrom }
        : null;

    return {
      grid: weeks,
      selectedBounds: bounds,
      thresholds: t,
    };
  }, [data, selectedRange]);

  const weekCount = grid.length;
  const minGridWidth = weekCount * CELL_SIZE + (weekCount - 1) * CELL_GAP;

  function handleDateSelect(date: string) {
    if (!onSelectRange) {
      return;
    }

    const nextDate = parseDateKey(date);

    if (!selectedRange?.from || selectedRange.to) {
      onSelectRange({ from: nextDate, to: undefined });
      return;
    }

    if (formatDateKey(selectedRange.from) === date) {
      onSelectRange(undefined);
      return;
    }

    if (nextDate < selectedRange.from) {
      onSelectRange({ from: nextDate, to: selectedRange.from });
      return;
    }

    onSelectRange({ from: selectedRange.from, to: nextDate });
  }

  return (
    <div className="flex flex-col gap-1">
      {/* direction:rtl makes the scroll container start at the right (most recent).
          The inner grid resets to direction:ltr so visual order is correct. */}
      <div
        className="overflow-x-auto [scrollbar-width:thin] [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-transparent hover:[&::-webkit-scrollbar-thumb]:bg-base-300"
        style={{ direction: "rtl" }}
      >
        <div
          className="grid"
          style={{
            direction: "ltr",
            gridTemplateColumns: `repeat(${weekCount}, 1fr)`,
            gridTemplateRows: `repeat(${DAYS_IN_WEEK}, auto)`,
            gap: CELL_GAP,
            minWidth: minGridWidth,
          }}
        >
          {grid.flatMap((week, wi) =>
            week.map((cell, di) => {
              if (cell.isFuture) {
                return (
                  <div
                    key={cell.date}
                    style={{
                      gridColumn: wi + 1,
                      gridRow: di + 1,
                      aspectRatio: "1 / 1",
                    }}
                  />
                );
              }

              const messageCount = cell.data?.messageCount ?? 0;
              const intensity = getIntensity(messageCount, thresholds);
              const hasActiveSelection = selectedBounds !== null;
              const isSelected =
                hasActiveSelection &&
                cell.date >= selectedBounds.from &&
                cell.date <= selectedBounds.to;
              const totalTokens =
                (cell.data?.inputTokens ?? 0) + (cell.data?.outputTokens ?? 0);
              const isInteractive = typeof onSelectRange === "function";

              const cellContent = isInteractive ? (
                <button
                  type="button"
                  aria-label={`Usage for ${formatDate(cell.date)}`}
                  aria-pressed={isSelected}
                  className={cn(
                    "block aspect-square w-full rounded-[3px] transition-[filter,opacity,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 focus-visible:ring-offset-1",
                    "hover:opacity-85",
                    INTENSITY_CLASSES[intensity],
                    hasActiveSelection &&
                      !isSelected &&
                      "grayscale opacity-35 saturate-0",
                    isSelected &&
                      "ring-2 ring-base-content/70 ring-offset-1 ring-offset-base-100",
                  )}
                  style={{
                    gridColumn: wi + 1,
                    gridRow: di + 1,
                  }}
                  onClick={() => handleDateSelect(cell.date)}
                />
              ) : (
                <div
                  className={cn(
                    "aspect-square rounded-[3px] transition-[filter,opacity,box-shadow]",
                    INTENSITY_CLASSES[intensity],
                    hasActiveSelection &&
                      !isSelected &&
                      "grayscale opacity-35 saturate-0",
                    isSelected &&
                      "ring-2 ring-base-content/70 ring-offset-1 ring-offset-base-100",
                  )}
                  style={{
                    gridColumn: wi + 1,
                    gridRow: di + 1,
                  }}
                />
              );

              return (
                <Tooltip key={cell.date}>
                  <TooltipTrigger asChild>{cellContent}</TooltipTrigger>
                  <TooltipContent side="top">
                    <div className="text-xs">
                      <div className="font-medium">{formatDate(cell.date)}</div>
                      {messageCount > 0 ? (
                        <div className="font-mono tabular-nums">
                          <div>
                            {messageCount} message
                            {messageCount !== 1 ? "s" : ""}
                          </div>
                          <div>{formatTokens(totalTokens)} tokens</div>
                          <div>
                            {cell.data?.toolCallCount ?? 0} tool call
                            {(cell.data?.toolCallCount ?? 0) !== 1 ? "s" : ""}
                          </div>
                        </div>
                      ) : (
                        <div className="text-base-content/60">No activity</div>
                      )}
                    </div>
                  </TooltipContent>
                </Tooltip>
              );
            }),
          )}
        </div>
      </div>

      <div className="mt-3 flex items-center justify-end gap-1 text-xs text-base-content/60">
        <span>Less</span>
        {INTENSITY_CLASSES.map((cls, i) => (
          <div
            key={i}
            className={cn("rounded-[2px]", cls)}
            style={{ width: LEGEND_CELL_SIZE, height: LEGEND_CELL_SIZE }}
          />
        ))}
        <span>More</span>
      </div>
    </div>
  );
}
