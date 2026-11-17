import { ADMIN_TIME_ZONE, ADMIN_TIME_ZONE_LABEL, date, day } from "./format";

/**
 * 统一时间展示。日期文本按北京时间渲染，title 里保留原始 UTC 时间，
 * 方便运营在审计/账单场景核对真实时刻，避免误读成本地时间。
 */
export function Time({
  value,
  mode = "datetime",
}: {
  value: string | null | undefined;
  mode?: "datetime" | "day";
}) {
  const parsed = value ? new Date(value) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) return <>—</>;
  return (
    <time
      dateTime={parsed.toISOString()}
      title={`${parsed.toISOString()} · ${ADMIN_TIME_ZONE_LABEL} · ${ADMIN_TIME_ZONE}`}
    >
      {mode === "day" ? day(value) : date(value)}
    </time>
  );
}
